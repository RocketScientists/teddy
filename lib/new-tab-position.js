// Moves newly created tabs to the start or end of the tab strip, per settings.
//
// Restored tabs (reopen closed tab, restore window, session/crash restore) fire
// tabs.onCreated like any new tab and have no opener, but Chrome puts them back
// where they were, so they must be left alone. Chrome doesn't flag them, so we
// recognise them two ways:
//   - the tab's window was created moments ago (window/session/crash restore);
//   - the tab's URL matches a tab closed recently (reopen closed tab).
import { loadSettings } from "./settings.js";
import { EDGE, moveGroupToEdge, moveTabsToEdge } from "./tab-move.js";

const NEW_TAB_PAGES = ["chrome://newtab/", "chrome://new-tab-page/"];

// Tabs created this soon after their window are treated as part of a restore.
// A brand-new window only has its one tab, so skipping it costs nothing.
const NEW_WINDOW_GRACE_MS = 2000;
// How many closed tabs to remember, and for how long, to recognise reopens.
const RECENTLY_CLOSED_LIMIT = 25;
const RECENTLY_CLOSED_TTL_MS = 30 * 60_000;
// storage.session survives the worker stopping and is cleared when Chrome quits.
const RECENTLY_CLOSED_KEY = "recentlyClosedTabs";

/** Last known URL of each open tab (onRemoved doesn't say what a tab showed). */
const tabUrls = new Map();
/** When each window was created, for windows created while the worker was running. */
const windowCreatedAt = new Map();
// Serialises read-modify-write of the recently closed list (closing a window
// removes many tabs at once).
let recentlyClosedQueue = Promise.resolve();
// A tab opened from another app also gets an openerTabId (Chrome uses the
// active tab), so an opener alone doesn't mean "opened from a link". Chrome
// fires webNavigation.onCreatedNavigationTarget only for tabs a page opened
// (link, window.open, middle-click), within a few milliseconds of tabs.onCreated.
const LINK_SIGNAL_WAIT_MS = 150;
// Link targets nobody asks about (the setting is off, or the tab is pinned) are
// forgotten after this long, so the map can't grow while the worker runs.
const LINK_TARGET_TTL_MS = 10_000;
/** Tabs a page opened: tab ID → when Chrome said so. */
const linkTargets = new Map();
/** Tabs waiting to hear whether a page opened them: tab ID → done(fromPage). */
const linkWaiters = new Map();
/** Windows where Teddy itself is opening tabs (restoring a saved group), with a count. */
const pausedWindows = new Map();

/**
 * Leave tabs created in `windowId` alone while `fn` runs. Teddy uses this when
 * it opens tabs itself, so they aren't moved to an edge or pulled out of the
 * group they're about to join. In practice onCreated fires before tabs.create
 * resolves, so every tab `fn` creates is seen while the pause is on; placeNewTab
 * also re-checks the tab's group before moving it, in case one slips through.
 * @template T
 * @param {number} windowId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withNewTabPositioningPaused(windowId, fn) {
  pausedWindows.set(windowId, (pausedWindows.get(windowId) || 0) + 1);
  try {
    return await fn();
  } finally {
    const count = pausedWindows.get(windowId) - 1;
    if (count) pausedWindows.set(windowId, count);
    else pausedWindows.delete(windowId);
  }
}

/** Register the listeners. Call once, synchronously, at the top level of the service worker. */
export function startNewTabPositioning() {
  const seeded = rememberOpenTabs();

  chrome.windows.onCreated.addListener((win) => windowCreatedAt.set(win.id, Date.now()));
  chrome.windows.onRemoved.addListener((windowId) => windowCreatedAt.delete(windowId));

  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url) tabUrls.set(tabId, change.url);
  });
  chrome.webNavigation.onCreatedNavigationTarget.addListener(({ tabId }) => {
    const waiter = linkWaiters.get(tabId);
    if (waiter) return waiter(true);
    const now = Date.now();
    for (const [id, at] of linkTargets) if (now - at > LINK_TARGET_TTL_MS) linkTargets.delete(id);
    linkTargets.set(tabId, now);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    linkTargets.delete(tabId);
    seeded
      .then(() => {
        const url = tabUrls.get(tabId);
        tabUrls.delete(tabId);
        if (isRememberable(url)) return updateRecentlyClosed((list) => [{ url, at: Date.now() }, ...list]);
      })
      .catch((err) => console.warn("Teddy: couldn't record closed tab:", errorMessage(err)));
  });

  chrome.tabs.onCreated.addListener((tab) => {
    const url = tab.pendingUrl || tab.url;
    if (url) tabUrls.set(tab.id, url);
    if (pausedWindows.has(tab.windowId)) return skip(tab, "Teddy opened it while restoring a saved group");
    placeNewTab(tab, url).catch((err) =>
      console.warn("Teddy: couldn't move new tab:", errorMessage(err))
    );
  });
}

async function placeNewTab(tab, url) {
  const settings = await loadSettings();
  if (!shouldMove(tab, settings)) return skip(tab, "settings say leave it", { pinned: tab.pinned, group: tab.groupId });
  const fromAnotherTab = tab.openerTabId !== undefined && !NEW_TAB_PAGES.includes(url);
  if (fromAnotherTab && !settings.moveTabsOpenedFromLinks) {
    if (await openedFromPage(tab.id)) return skip(tab, "it was opened from a link in another tab");
    if (await isDuplicate(tab, url)) return skip(tab, "it duplicates the tab before it");
  }
  if (isInNewWindow(tab)) return skip(tab, "its window just opened (treated as a window or session restore)");
  if (await consumeRecentlyClosed(url)) return skip(tab, "it matches a recently closed tab (treated as a reopen)");

  // The tab may have been grouped or pinned while we waited; moving would undo that.
  const current = await chrome.tabs.get(tab.id).catch(() => null);
  if (!current || current.pinned || current.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    return skip(tab, "it was closed, pinned or grouped meanwhile");
  }
  await moveTabsToEdge([current], settings.newTabPosition);
  console.debug("Teddy: moved new tab to", settings.newTabPosition, url);
}

/**
 * Move a newly created group to where the "New tabs" setting puts new tabs.
 * With "default" it stays where it is.
 * @param {number} groupId
 * @param {number} windowId
 */
export async function moveGroupToNewTabPosition(groupId, windowId) {
  const { newTabPosition } = await loadSettings();
  if (newTabPosition === EDGE.start || newTabPosition === EDGE.end) {
    await moveGroupToEdge(groupId, windowId, newTabPosition);
  }
}

/** Why a new tab was left where Chrome put it. Shown with the console's Verbose level. */
function skip(tab, reason, details) {
  console.debug(`Teddy: left new tab ${tab.id} alone: ${reason}`, tab.pendingUrl || tab.url, details ?? "");
}

/**
 * Duplicating a tab gives the copy an opener but fires no link event. The copy
 * sits right after the original and shows the same URL. (Its opener is the
 * active tab, which isn't always the original.)
 */
async function isDuplicate(tab, url) {
  if (tab.index === 0) return false;
  const [before] = await chrome.tabs.query({ windowId: tab.windowId, index: tab.index - 1 });
  return Boolean(before) && (before.url === url || before.pendingUrl === url);
}

/**
 * Whether the settings ask for new tabs to be moved, and this tab can be.
 * Tabs opened from a link are checked separately (openedFromPage).
 */
function shouldMove(tab, settings) {
  if (settings.newTabPosition !== EDGE.start && settings.newTabPosition !== EDGE.end) return false;
  // Pinned tabs have their own area, and grouped tabs belong where their group is.
  return !tab.pinned && tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE;
}

/**
 * Whether a page opened this tab (a link, window.open, middle-click), as opposed
 * to another app, the browser or another extension. Waits briefly for Chrome's signal.
 * @returns {Promise<boolean>}
 */
function openedFromPage(tabId) {
  if (linkTargets.delete(tabId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (fromPage) => {
      clearTimeout(timer);
      linkWaiters.delete(tabId);
      resolve(fromPage);
    };
    const timer = setTimeout(() => done(false), LINK_SIGNAL_WAIT_MS);
    linkWaiters.set(tabId, done);
  });
}

function isInNewWindow(tab) {
  const createdAt = windowCreatedAt.get(tab.windowId);
  return createdAt !== undefined && Date.now() - createdAt < NEW_WINDOW_GRACE_MS;
}

/**
 * The new-tab page and blank tabs aren't worth remembering: a fresh one would
 * look like a reopened one and never be moved.
 */
function isRememberable(url) {
  return Boolean(url) && url !== "about:blank" && !NEW_TAB_PAGES.includes(url);
}

/** If `url` was closed recently, forget that entry and return true. */
async function consumeRecentlyClosed(url) {
  if (!isRememberable(url)) return false;
  let found = false;
  await updateRecentlyClosed((list) => {
    const i = list.findIndex((entry) => entry.url === url);
    if (i === -1) return list;
    found = true;
    return list.filter((_, j) => j !== i);
  });
  return found;
}

/** Apply `change` to the stored list (newest first), dropping expired and excess entries. */
function updateRecentlyClosed(change) {
  const run = recentlyClosedQueue.then(async () => {
    const stored = await chrome.storage.session.get({ [RECENTLY_CLOSED_KEY]: [] });
    const fresh = stored[RECENTLY_CLOSED_KEY].filter(
      (entry) => Date.now() - entry.at < RECENTLY_CLOSED_TTL_MS
    );
    const next = change(fresh).slice(0, RECENTLY_CLOSED_LIMIT);
    await chrome.storage.session.set({ [RECENTLY_CLOSED_KEY]: next });
  });
  recentlyClosedQueue = run.catch(() => {});
  return run;
}

/** Fill tabUrls when the worker starts, since it misses events while stopped. */
async function rememberOpenTabs() {
  for (const tab of await chrome.tabs.query({})) {
    const url = tab.pendingUrl || tab.url;
    if (url && !tabUrls.has(tab.id)) tabUrls.set(tab.id, url);
  }
}

function errorMessage(err) {
  return String(err?.message || err);
}
