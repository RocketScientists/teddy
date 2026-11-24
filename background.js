import { loadSettings, parseCategories, validateSettings } from "./lib/settings.js";
import { classifyPage } from "./lib/llm.js";
import { MESSAGE } from "./lib/messages.js";
import { moveTabsToEdge, startTabPositioning } from "./lib/tab-position.js";

const MENU = {
  classify: "classify-tab",
  moveToStart: "move-tabs-to-start",
  moveToEnd: "move-tabs-to-end",
};

// The move menu ids double as the shortcut command names in manifest.json.
const MOVE_EDGE_BY_ID = { [MENU.moveToStart]: "start", [MENU.moveToEnd]: "end" };

chrome.runtime.onInstalled.addListener(() => {
  const contexts = ["page", "action"];
  chrome.contextMenus.create({ id: MENU.classify, title: "Classify tab into group", contexts });
  chrome.contextMenus.create({ id: MENU.moveToStart, title: "Move tab(s) to start of tab strip", contexts });
  chrome.contextMenus.create({ id: MENU.moveToEnd, title: "Move tab(s) to end of tab strip", contexts });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  if (info.menuItemId === MENU.classify) {
    await runWithBadge(() => classifyTabs([tab]));
  } else if (MOVE_EDGE_BY_ID[info.menuItemId]) {
    await moveTabs(() => tabsToMove(tab), MOVE_EDGE_BY_ID[info.menuItemId]);
  }
});

/** The clicked tab, plus the other selected tabs if it is part of a multi-selection. */
async function tabsToMove(clickedTab) {
  if (!clickedTab.highlighted) return [clickedTab];
  return chrome.tabs.query({ windowId: clickedTab.windowId, highlighted: true });
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "classify-selected-tabs") {
    await runWithBadge(async () => classifyTabs(await getSelectedTabs()));
  } else if (MOVE_EDGE_BY_ID[command]) {
    await moveTabs(getSelectedTabs, MOVE_EDGE_BY_ID[command]);
  }
});

/** Move tabs to an edge of the tab strip; failures are only logged (there's no UI to show them). */
async function moveTabs(getTabs, edge) {
  try {
    await moveTabsToEdge(await getTabs(), edge);
  } catch (err) {
    console.warn("Teddy: couldn't move tabs:", errorMessage(err));
  }
}

// Optionally force new tabs to the start or end of the tab strip.
startTabPositioning();

// Messages from the popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === MESSAGE.classifySelected) {
    getSelectedTabs()
      .then(classifyTabs)
      .then((results) => sendResponse({ ok: true, results }))
      .catch((err) => sendResponse({ ok: false, error: errorMessage(err) }));
    return true; // keep the channel open for the async response
  }
});

/**
 * Highlighted (multi-selected) tabs in the last focused window; falls back to the active tab.
 * Uses lastFocusedWindow because a service worker has no "current" window of its own.
 */
async function getSelectedTabs() {
  let tabs = await chrome.tabs.query({ lastFocusedWindow: true, highlighted: true });
  if (!tabs.length) tabs = await chrome.tabs.query({ lastFocusedWindow: true, active: true });
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

/** Badge feedback for triggers that have no UI (shortcut, context menu). */
async function runWithBadge(fn) {
  await chrome.action.setBadgeText({ text: "…" });
  try {
    const results = await fn();
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
