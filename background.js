import { loadSettings, parseCategories, validateSettings } from "./lib/settings.js";
import { classifyPage } from "./lib/llm.js";
import { MESSAGE } from "./lib/messages.js";
import { startNewTabPositioning } from "./lib/new-tab-position.js";
import { EDGE, moveTabsToEdge } from "./lib/tab-move.js";
import { restoreGroup, saveGroup } from "./lib/bookmarks.js";

// Each action's id is both its context-menu item id and, where it has one, its
// command name in manifest.json "commands". `menu` is the menu item title.
// `run(tab)` gets the tab the menu was opened on (undefined for a shortcut);
// it returns per-tab results for runWithBadge, or nothing when there are none.
const ACTIONS = {
  "classify-tab": {
    menu: "Classify tab into group",
    run: (tab) => classifyTabs([tab]),
  },
  "classify-selected-tabs": {
    run: async () => classifyTabs(await getSelectedTabs()),
  },
  "move-tabs-to-start": {
    menu: "Move tab(s) to start of tab strip",
    run: async (tab) => moveTabsToEdge(await getSelectedTabs(tab?.windowId), EDGE.start),
  },
  "move-tabs-to-end": {
    menu: "Move tab(s) to end of tab strip",
    run: async (tab) => moveTabsToEdge(await getSelectedTabs(tab?.windowId), EDGE.end),
  },
  "save-tab-group": {
    menu: "Save tab group to bookmarks",
    run: async (tab) => saveCurrentGroup(tab),
  },
  "save-tab-groups-in-window": {
    menu: "Save all tab groups in window to bookmarks",
    run: async (tab) => saveGroupsInWindow(tab),
  },
};

chrome.runtime.onInstalled.addListener(() => {
  for (const [id, { menu }] of Object.entries(ACTIONS)) {
    if (menu) chrome.contextMenus.create({ id, title: menu, contexts: ["page", "action"] });
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const action = ACTIONS[info.menuItemId];
  if (action && tab) await runWithBadge(() => action.run(tab));
});

chrome.commands.onCommand.addListener(async (command) => {
  const action = ACTIONS[command];
  if (action) await runWithBadge(() => action.run());
});

// Optionally force new tabs to the start or end of the tab strip.
startNewTabPositioning();

// Messages from the popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === MESSAGE.classifySelected) {
    getSelectedTabs()
      .then(classifyTabs)
      .then((results) => sendResponse({ ok: true, results }))
      .catch((err) => sendResponse({ ok: false, error: errorMessage(err) }));
    return true; // keep the channel open for the async response
  }
  if (msg?.type === MESSAGE.restoreSavedGroup) {
    restoreGroup(msg.folderId, msg.windowId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: errorMessage(err) }));
    return true;
  }
});

/** The tab a menu was opened on, or the active tab of the last focused window. */
async function currentTab(tab) {
  if (tab) return tab;
  const [active] = await chrome.tabs.query({ lastFocusedWindow: true, active: true });
  if (!active) throw new Error("No active tab found. Focus a browser window and try again.");
  return active;
}

async function saveCurrentGroup(tab) {
  tab = await currentTab(tab);
  if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
    throw new Error("This tab isn't in a tab group.");
  }
  const saved = await saveGroup(tab.groupId);
  console.info("Teddy: saved", saved);
}

/** Save every named group in the window. Unnamed groups are skipped, not failures. */
async function saveGroupsInWindow(tab) {
  tab = await currentTab(tab);
  const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
  if (!groups.length) throw new Error("This window has no tab groups.");
  const results = [];
  for (const group of groups) {
    if (!group.title?.trim()) {
      console.info("Teddy: skipped an unnamed tab group");
      continue;
    }
    try {
      results.push({ ok: true, ...(await saveGroup(group.id)) });
    } catch (err) {
      results.push({ ok: false, name: group.title, error: errorMessage(err) });
    }
  }
  console.info("Teddy: saved", results);
  return results;
}

/**
 * Highlighted (multi-selected) tabs in a window; falls back to the active tab.
 * Without `windowId` it uses the last focused window, because a service worker
 * has no "current" window of its own. The active tab is always highlighted, so
 * a context-menu click (whose tab is the active one) gets the whole selection.
 * @param {number} [windowId]
 */
async function getSelectedTabs(windowId) {
  const win = windowId === undefined ? { lastFocusedWindow: true } : { windowId };
  let tabs = await chrome.tabs.query({ ...win, highlighted: true });
  if (!tabs.length) tabs = await chrome.tabs.query({ ...win, active: true });
  if (!tabs.length) throw new Error("No selected tab found. Focus a browser window and try again.");
  return tabs;
}

// Runs from the popup, shortcut and context menu share one queue, so two
// overlapping runs can't both create a group with the same name.
let runQueue = Promise.resolve();

function classifyTabs(tabs) {
  const run = runQueue.then(() => classifyTabsNow(tabs));
  runQueue = run.catch(() => {});
  return run;
}

/**
 * Classify tabs one by one (sequentially, so a group created for one tab
 * is offered to the model as an existing group for the next).
 */
async function classifyTabsNow(tabs) {
  const settings = await loadSettings();
  const settingsProblem = validateSettings(settings);
  if (settingsProblem) throw new Error(settingsProblem);
  const preferredGroups = parseCategories(settings.categories);

  const results = [];
  for (const tab of tabs) {
    try {
      if (tab.pinned) throw new Error("Pinned tabs can't be grouped. Unpin it first.");
      const page = await extractPage(tab, settings.maxContentChars);
      const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
      const groupContext = {
        existingGroups: groups.map((g) => g.title).filter(Boolean),
        preferredGroups,
      };

      const classification = await classifyPage(settings, page, groupContext);
      const groupTitle = await moveTabToGroup(tab, classification, groups);
      results.push({ tabId: tab.id, title: tab.title, group: groupTitle, ok: true });
    } catch (err) {
      results.push({ tabId: tab.id, title: tab.title, ok: false, error: errorMessage(err) });
    }
  }
  return results;
}

/** Get title/URL plus a text excerpt from the page. Falls back to title+URL on restricted pages. */
async function extractPage(tab, maxChars) {
  const titleAndUrl = { title: tab.title || "", url: tab.url || "" };
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (limit) => {
        const meta = (name) =>
          document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.content || "";
        const root = document.querySelector("main, article") || document.body;
        const text = (root?.innerText || "").replace(/\s+/g, " ").trim().slice(0, limit);
        return {
          description: meta("description") || meta("og:description"),
          text,
        };
      },
      args: [maxChars],
    });
    return { ...titleAndUrl, ...(injection?.result || {}) };
  } catch {
    // chrome://, Web Store, PDF viewer, discarded tabs, etc. can't be scripted.
    return titleAndUrl;
  }
}

/**
 * Join the group whose title matches the classification (ignoring case), or create it.
 * @returns {Promise<string>} the title of the group the tab ended up in
 */
async function moveTabToGroup(tab, { group: groupName, color }, groupsInWindow) {
  const existing = groupsInWindow.find(
    (g) => (g.title || "").toLowerCase() === groupName.toLowerCase()
  );
  if (existing) {
    await chrome.tabs.group({ tabIds: [tab.id], groupId: existing.id });
    return existing.title;
  }
  const groupId = await chrome.tabs.group({
    tabIds: [tab.id],
    createProperties: { windowId: tab.windowId },
  });
  await chrome.tabGroups.update(groupId, { title: groupName, color });
  return groupName;
}

const BADGE = {
  success: { text: "✓", color: "#188038" },
  failure: { text: "!", color: "#d93025" },
};

async function setBadge({ text, color }) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

function errorMessage(err) {
  return String(err?.message || err);
}

/**
 * Badge feedback for triggers that have no UI (shortcut, context menu).
 * @param {() => Promise<{ok:boolean}[] | void>} fn  per-tab results, if it has any;
 *   a throw means failure, otherwise success unless a result is not ok
 */
async function runWithBadge(fn) {
  await chrome.action.setBadgeText({ text: "…" });
  try {
    const results = (await fn()) || [];
    const failed = results.filter((r) => !r.ok);
    if (failed.length) console.warn("Teddy failures:", failed);
    await setBadge(failed.length ? BADGE.failure : BADGE.success);
  } catch (err) {
    console.error("Teddy:", err);
    await setBadge(BADGE.failure);
  }
  // Best effort: lost if Chrome stops the worker first. The popup and the
  // next run also clear the badge, so it can't stay stale for long.
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3000);
}

chrome.runtime.onStartup.addListener(() => chrome.action.setBadgeText({ text: "" }));
