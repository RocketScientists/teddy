// Keeps the "Save tab group" menu item's title showing the group it would
// save: the group of the active tab in the focused window. Chrome has no
// "menu shown" event, so the title follows tab, group and window changes.

const MAX_NAME_CHARS = 40;

let menuId;
let refreshing = Promise.resolve();

/**
 * Register the listeners. Call at the top level of the worker, because MV3
 * listeners must be registered synchronously.
 * @param {string} id  the context-menu item to retitle
 */
export function startSaveMenuTitle(id) {
  menuId = id;
  chrome.tabs.onActivated.addListener(refreshSaveMenuTitle);
  chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
    if (tab.active && "groupId" in change) refreshSaveMenuTitle();
  });
  chrome.tabGroups.onUpdated.addListener(refreshSaveMenuTitle);
  chrome.tabGroups.onRemoved.addListener(refreshSaveMenuTitle);
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) refreshSaveMenuTitle();
  });
  refreshSaveMenuTitle();
}

/** Update the title now. Updates run one after another, so the last one wins. */
export function refreshSaveMenuTitle() {
  refreshing = refreshing.then(updateTitle).catch(() => {
    // The menu item may not exist yet (it's created on install); onInstalled refreshes again.
  });
  return refreshing;
}

async function updateTitle() {
  const [tab] = await chrome.tabs.query({ lastFocusedWindow: true, active: true });
  let title = "Save tab group to bookmarks (tab isn't in a group)";
  let enabled = false;
  if (tab && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    const group = await chrome.tabGroups.get(tab.groupId);
    const name = (group.title || "").trim();
    if (name) {
      title = `Save tab group "${shorten(name)}" to bookmarks`;
      enabled = true;
    } else {
      title = "Save tab group to bookmarks (group has no name)";
    }
  }
  await chrome.contextMenus.update(menuId, { title, enabled });
}

function shorten(name) {
  return name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS - 1)}…` : name;
}
