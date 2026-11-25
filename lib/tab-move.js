// Moving tabs to the start or end of the tab strip. Shared by the "move tabs"
// menu items/shortcuts and the "New tabs" setting (lib/new-tab-position.js).

const MOVE_RETRIES = 5;
const RETRY_DELAY_MS = 100;

/** The two edges of the tab strip a tab can be moved to. */
export const EDGE = { start: "start", end: "end" };

/**
 * Move tabs (all in one window) to the start or end of the tab strip, keeping
 * their order. Pinned tabs stay in the pinned area, so they go to its start or
 * end. Grouped tabs leave their group, and no tab ends up joining the group it
 * lands next to.
 * @param {chrome.tabs.Tab[]} tabs
 * @param {"start"|"end"} edge  one of EDGE
 */
export async function moveTabsToEdge(tabs, edge) {
  if (!tabs.length) return;
  const sorted = [...tabs].sort((a, b) => a.index - b.index);
  const pinnedIds = sorted.filter((t) => t.pinned).map((t) => t.id);
  const unpinned = sorted.filter((t) => !t.pinned);
  const unpinnedIds = unpinned.map((t) => t.id);

  // Pinned tabs can't be grouped. -1 puts them at the end of the pinned area,
  // and (unlike a fixed index) keeps their order: Chrome adds 1 to a fixed index
  // after each tab it moves.
  if (pinnedIds.length) await moveWithRetry(pinnedIds, edge === EDGE.start ? 0 : -1);

  if (unpinnedIds.length) {
    await ungroupWithRetry(unpinned.filter(isGrouped).map((t) => t.id));
    const index = edge === EDGE.start ? await firstUnpinnedIndex(sorted[0].windowId) : -1;
    await moveWithRetry(unpinnedIds, index);
    // Landing right next to a group can put a tab into it; undo that.
    const moved = await Promise.all(unpinnedIds.map((id) => chrome.tabs.get(id)));
    await ungroupWithRetry(moved.filter(isGrouped).map((t) => t.id));
  }
}

/**
 * Move a whole tab group to the start (just after pinned tabs) or end of the tab strip.
 * @param {number} groupId
 * @param {number} windowId
 * @param {"start"|"end"} edge  one of EDGE
 */
export async function moveGroupToEdge(groupId, windowId, edge) {
  const index = edge === EDGE.start ? await firstUnpinnedIndex(windowId) : -1;
  await withRetry(() => chrome.tabGroups.move(groupId, { index }));
}

function isGrouped(tab) {
  return tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE;
}

/** Unpinned tabs can't sit before pinned ones, so "start" means just after them. */
async function firstUnpinnedIndex(windowId) {
  const pinned = await chrome.tabs.query({ windowId, pinned: true });
  return pinned.length;
}

/** @param {number|number[]} tabIds  several ids are moved together, in order */
function moveWithRetry(tabIds, index) {
  return withRetry(() => chrome.tabs.move(tabIds, { index }));
}

function ungroupWithRetry(tabIds) {
  if (!tabIds.length) return;
  return withRetry(() => chrome.tabs.ungroup(tabIds));
}

/** Chrome refuses tab edits while the user is dragging a tab; wait briefly and retry. */
async function withRetry(edit) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await edit();
    } catch (err) {
      const busy = /cannot be edited right now/i.test(err?.message || "");
      if (!busy || attempt >= MOVE_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}
