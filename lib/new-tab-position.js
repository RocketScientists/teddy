// Moves newly created tabs to the start or end of the tab strip, per settings.
//
// Restored tabs (reopen closed tab, restore window, session/crash restore) fire
// tabs.onCreated like any new tab and have no opener, but Chrome puts them back
// where they were, so they must be left alone. Chrome doesn't flag them, so we
// recognise them two ways:
//   - the tab's window was created moments ago (window/session/crash restore);
//   - the tab's URL matches a tab closed recently (reopen closed tab).
import { loadSettings } from "./settings.js";
import { EDGE, moveTabsToEdge } from "./tab-move.js";

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

/** Register the listeners. Call once, synchronously, at the top level of the service worker. */
export function startNewTabPositioning() {
  const seeded = rememberOpenTabs();

  chrome.windows.onCreated.addListener((win) => windowCreatedAt.set(win.id, Date.now()));
  chrome.windows.onRemoved.addListener((windowId) => windowCreatedAt.delete(windowId));

  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url) tabUrls.set(tabId, change.url);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
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
    placeNewTab(tab, url).catch((err) =>
      console.warn("Teddy: couldn't move new tab:", errorMessage(err))
    );
  });
}

async function placeNewTab(tab, url) {
  const settings = await loadSettings();
  if (!shouldMove(tab, url, settings)) return;
  if (isInNewWindow(tab) || (await consumeRecentlyClosed(url))) return; // restored

  await moveTabsToEdge([tab], settings.newTabPosition);
}

/**
 * Whether the settings ask for this tab to be moved, before checking for restores.
 * The new-tab page (hotkey) and tabs from other apps are moved; tabs opened from
 * a link in another tab have an opener and are moved only if the user opted in.
 */
function shouldMove(tab, url, settings) {
  if (settings.newTabPosition !== EDGE.start && settings.newTabPosition !== EDGE.end) return false;
  // Pinned tabs have their own area, and grouped tabs belong where their group is.
  if (tab.pinned || tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return false;

  const isNewTabPage = NEW_TAB_PAGES.includes(url);
  if (tab.openerTabId !== undefined && !isNewTabPage && !settings.moveTabsOpenedFromLinks) {
    return false;
  }
  return true;
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
