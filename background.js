import { loadSettings, parseCategories } from "./lib/settings.js";
import { classifyTab } from "./lib/llm.js";

const MENU_ID = "classify-tab";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Classify tab into group",
    contexts: ["page", "action"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab) return;
  await runWithBadge(() => classifyTabs([tab]));
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "classify-selected-tabs") return;
  await runWithBadge(async () => classifyTabs(await getSelectedTabs()));
});

// Messages from the popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "classify-selected") {
    getSelectedTabs()
      .then(classifyTabs)
      .then((results) => sendResponse({ ok: true, results }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
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

/**
 * Classify tabs one by one (sequentially, so a group created for one tab
 * is offered to the model as an existing group for the next).
 */
async function classifyTabs(tabs) {
  const settings = await loadSettings();
  if (!settings.apiBaseUrl || !settings.model) {
    throw new Error("Configure the API base URL and model in the extension options first.");
  }
  const preferred = parseCategories(settings.categories);

  const results = [];
  for (const tab of tabs) {
    try {
      if (tab.pinned) throw new Error("Pinned tabs can't be grouped. Unpin it first.");
      const page = await extractPage(tab, settings.maxContentChars);
      const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
      const existingNames = groups.map((g) => g.title).filter(Boolean);

      const { group, color } = await classifyTab(settings, page, existingNames, preferred);
      await moveTabToGroup(tab, group, color, groups);
      results.push({ tabId: tab.id, title: tab.title, group, ok: true });
    } catch (err) {
      results.push({ tabId: tab.id, title: tab.title, ok: false, error: String(err.message || err) });
    }
  }
  return results;
}

/** Get title/URL plus a text excerpt from the page. Falls back to title+URL on restricted pages. */
async function extractPage(tab, maxChars) {
  const base = { title: tab.title || "", url: tab.url || "" };
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
    return { ...base, ...(injection?.result || {}) };
  } catch {
    // chrome://, Web Store, PDF viewer, discarded tabs, etc. can't be scripted.
    return base;
  }
}

async function moveTabToGroup(tab, groupName, color, groupsInWindow) {
  const existing = groupsInWindow.find(
    (g) => (g.title || "").toLowerCase() === groupName.toLowerCase()
  );
  if (existing) {
    await chrome.tabs.group({ tabIds: [tab.id], groupId: existing.id });
    return existing.id;
  }
  const groupId = await chrome.tabs.group({
    tabIds: [tab.id],
    createProperties: { windowId: tab.windowId },
  });
  await chrome.tabGroups.update(groupId, { title: groupName, color });
  return groupId;
}

/** Badge feedback for triggers that have no UI (shortcut, context menu). */
async function runWithBadge(fn) {
  await chrome.action.setBadgeText({ text: "…" });
  try {
    const results = await fn();
    const failed = results.filter((r) => !r.ok);
    if (failed.length) console.warn("Teddy failures:", failed);
    await chrome.action.setBadgeBackgroundColor({ color: failed.length ? "#d93025" : "#188038" });
    await chrome.action.setBadgeText({ text: failed.length ? "!" : "✓" });
  } catch (err) {
    console.error("Teddy:", err);
    await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    await chrome.action.setBadgeText({ text: "!" });
  }
  // Best effort: lost if Chrome stops the worker first. The popup and the
  // next run also clear the badge, so it can't stay stale for long.
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3000);
}

chrome.runtime.onStartup.addListener(() => chrome.action.setBadgeText({ text: "" }));
