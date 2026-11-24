// Moves newly created tabs to the start or end of the tab strip, per settings.
import { loadSettings } from "./settings.js";

const NEW_TAB_PAGES = ["chrome://newtab/", "chrome://new-tab-page/"];
const MOVE_RETRIES = 5;
const RETRY_DELAY_MS = 100;

/** Called from tabs.onCreated. Leaves the tab alone unless the settings say to move it. */
export async function placeNewTab(tab) {
  const settings = await loadSettings();
  if (!shouldMove(tab, settings)) return;

  const index =
    settings.newTabPosition === "start" ? await firstUnpinnedIndex(tab.windowId) : -1;
  await moveWithRetry(tab.id, index);
}

function shouldMove(tab, settings) {
  if (settings.newTabPosition !== "start" && settings.newTabPosition !== "end") return false;
  // Pinned tabs have their own area, and grouped tabs belong where their group is.
  if (tab.pinned || tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return false;

  // Tabs opened from a link in another tab have an opener. The hotkey's new tab
  // page and tabs opened from other apps are always moved.
  const isNewTabPage = NEW_TAB_PAGES.includes(tab.pendingUrl || tab.url);
  if (tab.openerTabId !== undefined && !isNewTabPage && !settings.moveTabsOpenedFromLinks) {
    return false;
  }
  return true;
}

/** Unpinned tabs can't sit before pinned ones, so "start" means just after them. */
async function firstUnpinnedIndex(windowId) {
  const pinned = await chrome.tabs.query({ windowId, pinned: true });
  return pinned.length;
}

/** Chrome refuses edits while the user is dragging a tab; wait briefly and retry. */
async function moveWithRetry(tabId, index) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await chrome.tabs.move(tabId, { index });
    } catch (err) {
      const busy = /cannot be edited right now/i.test(err?.message || "");
      if (!busy || attempt >= MOVE_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}
