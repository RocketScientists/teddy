// Saving tab groups as bookmark folders under a root folder, and restoring
// them. A group name is split on the group separator into a group path:
// "Project/ABC" is saved to <root> › Project › ABC. See GLOSSARY.md.

import { loadSettings } from "./settings.js";
import { withNewTabPositioningPaused } from "./new-tab-position.js";
import { EDGE, moveGroupToEdge } from "./tab-move.js";

const DEFAULT_ROOT_TITLE = "Teddy";
const DEFAULT_SEPARATOR = "/";
// Group colours by saved-group folder ID. Bookmarks can't hold a colour.
const COLORS_KEY = "savedGroupColors";

// Saves and restores share one queue, so two overlapping saves can't both
// create the same folder.
let queue = Promise.resolve();

function enqueue(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

function separatorOf(settings) {
  return settings.groupSeparator || DEFAULT_SEPARATOR;
}

/**
 * Split a group name into its group path. Parts are trimmed and empty parts dropped.
 * @returns {string[]}
 */
export function groupPath(name, separator) {
  return (name || "")
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The group name a group path restores to. */
export function groupNameFromPath(path, separator) {
  return path.join(separator);
}

/** Two group names are the same group if their paths match, ignoring case. */
function samePath(a, b) {
  return a.length === b.length && a.every((part, i) => part.toLowerCase() === b[i].toLowerCase());
}

function isFolder(node) {
  return !node.url;
}

async function otherBookmarksFolder() {
  const tops = await chrome.bookmarks.getChildren("0");
  return tops.find((n) => n.folderType === "other") || tops.find((n) => n.id === "2") || tops[1];
}

/**
 * The root folder: the one chosen in Settings if it still exists, otherwise
 * "Teddy" under "Other bookmarks".
 * @param {{create?: boolean}} [opts]  create the default folder if it's missing
 * @returns {Promise<chrome.bookmarks.BookmarkTreeNode|null>}
 */
export async function getRootFolder({ create = false } = {}, settings) {
  settings ||= await loadSettings();
  if (settings.bookmarkRootId) {
    try {
      const [node] = await chrome.bookmarks.get(settings.bookmarkRootId);
      if (node && isFolder(node)) return node;
    } catch {
      // Deleted: fall back to the default folder.
    }
  }
  const other = await otherBookmarksFolder();
  const children = await chrome.bookmarks.getChildren(other.id);
  const existing = children.find((n) => isFolder(n) && n.title === DEFAULT_ROOT_TITLE);
  if (existing) return existing;
  return create ? chrome.bookmarks.create({ parentId: other.id, title: DEFAULT_ROOT_TITLE }) : null;
}

/** Find or create the folder at `path` under `parentId`. Folder names match ignoring case. */
async function ensureFolder(parentId, path) {
  for (const part of path) {
    const children = await chrome.bookmarks.getChildren(parentId);
    const match = children.find((n) => isFolder(n) && n.title.toLowerCase() === part.toLowerCase());
    parentId = (match || (await chrome.bookmarks.create({ parentId, title: part }))).id;
  }
  return parentId;
}

/**
 * Save one tab group: its folder's direct bookmarks are replaced with the
 * group's tabs, in order. Subfolders are left alone.
 * @returns {Promise<{name: string, path: string[], count: number}>}
 */
export function saveGroup(groupId) {
  return enqueue(() => saveGroupNow(groupId));
}

async function saveGroupNow(groupId) {
  const settings = await loadSettings();
  const group = await chrome.tabGroups.get(groupId);
  const path = groupPath(group.title, separatorOf(settings));
  if (!path.length) throw new Error("This tab group has no name. Name it before saving it.");

  const root = await getRootFolder({ create: true }, settings);
  const folderId = await ensureFolder(root.id, path);
  const tabs = (await chrome.tabs.query({ groupId })).sort((a, b) => a.index - b.index);
  const old = (await chrome.bookmarks.getChildren(folderId)).filter((n) => !isFolder(n));

  // Add the new bookmarks before removing the old ones, so a failure part
  // way through never leaves the folder emptier than before.
  let index = 0;
  for (const tab of tabs) {
    const url = tab.url || tab.pendingUrl;
    if (!url) continue;
    await chrome.bookmarks.create({ parentId: folderId, index: index++, title: tab.title || url, url });
  }
  for (const node of old) await chrome.bookmarks.remove(node.id);

  const { [COLORS_KEY]: colors = {} } = await chrome.storage.local.get(COLORS_KEY);
  colors[folderId] = group.color;
  await chrome.storage.local.set({ [COLORS_KEY]: colors });

  return { name: group.title, path, count: index };
}

/**
 * Restore a saved group into a window. If the window has a group with the same
 * path (ignoring case and spacing), the missing URLs are added to it; otherwise
 * a new group is created with the saved colour, at the start of the tab strip
 * if the "New tabs" setting says start, and at the end otherwise.
 * Subfolders are not restored.
 * @returns {Promise<{name: string, opened: number, skipped: number, failed: number}>}
 */
export function restoreGroup(folderId, windowId) {
  // The "New tabs" setting must not move the tabs a restore opens, or pull them
  // back out of the group.
  return enqueue(() => withNewTabPositioningPaused(windowId, () => restoreGroupNow(folderId, windowId)));
}

async function restoreGroupNow(folderId, windowId) {
  const settings = await loadSettings();
  const separator = separatorOf(settings);
  const root = await getRootFolder({}, settings);
  if (!root) throw new Error("Nothing saved yet.");
  const path = await pathUnderRoot(folderId, root.id);
  const bookmarks = (await chrome.bookmarks.getChildren(folderId)).filter((n) => !isFolder(n));
  if (!bookmarks.length) throw new Error("This folder has no bookmarks to restore.");

  const groups = await chrome.tabGroups.query({ windowId });
  const existing = groups.find((g) => samePath(groupPath(g.title, separator), path));

  let toOpen = bookmarks;
  let index; // undefined: the end of the tab strip
  if (existing) {
    const groupTabs = await chrome.tabs.query({ groupId: existing.id });
    const open = new Set(groupTabs.map((t) => t.url || t.pendingUrl));
    toOpen = bookmarks.filter((b) => !open.has(b.url));
    index = Math.max(...groupTabs.map((t) => t.index)) + 1;
  }

  const tabIds = [];
  let failed = 0;
  for (const bookmark of toOpen) {
    try {
      const tab = await chrome.tabs.create({ windowId, url: bookmark.url, active: false, index });
      tabIds.push(tab.id);
      if (index !== undefined) index++;
    } catch (err) {
      // e.g. javascript: bookmarklets can't be opened as tabs.
      console.warn("Teddy: couldn't open bookmark", bookmark.url, err);
      failed++;
    }
  }

  const name = existing?.title || groupNameFromPath(path, separator);
  const result = { name, opened: tabIds.length, skipped: bookmarks.length - toOpen.length, failed };
  if (!tabIds.length) {
    if (failed) throw new Error("None of the bookmarks could be opened.");
    return result;
  }
  if (existing) {
    await chrome.tabs.group({ groupId: existing.id, tabIds });
  } else {
    const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
    const { [COLORS_KEY]: colors = {} } = await chrome.storage.local.get(COLORS_KEY);
    const update = { title: name, collapsed: false };
    if (colors[folderId]) update.color = colors[folderId];
    await chrome.tabGroups.update(groupId, update);
    // A restored group opens where new tabs do. The tabs were created at the
    // end, which is already right for "end" and "default".
    if (settings.newTabPosition === EDGE.start) await moveGroupToEdge(groupId, windowId, EDGE.start);
  }
  return result;
}

/** Folder names from the root down to `folderId`. Throws if it isn't under the root. */
async function pathUnderRoot(folderId, rootId) {
  if (folderId === rootId) throw new Error("The root folder itself isn't a saved group.");
  const path = [];
  let id = folderId;
  while (id !== rootId) {
    const [node] = await chrome.bookmarks.get(id);
    if (!node?.parentId) throw new Error("That folder isn't under Teddy's root folder.");
    const part = node.title.trim();
    if (part) path.unshift(part);
    id = node.parentId;
  }
  if (!path.length) throw new Error("That folder has no name to use as a group name.");
  return path;
}

/**
 * The saved groups under the root folder, depth first, for the popup.
 * @returns {Promise<{root: string, groups: {id: string, title: string, depth: number, count: number}[]}|null>}
 */
export async function listSavedGroups() {
  const root = await getRootFolder();
  if (!root) return null;
  const [tree] = await chrome.bookmarks.getSubTree(root.id);
  const groups = [];
  const walk = (node, depth) => {
    for (const child of node.children || []) {
      if (!isFolder(child)) continue;
      const count = (child.children || []).filter((n) => !isFolder(n)).length;
      groups.push({ id: child.id, title: child.title, depth, count });
      walk(child, depth + 1);
    }
  };
  walk(tree, 0);
  return { root: root.title, groups };
}

/**
 * Every folder that can be a root folder, with its full path, for Settings.
 * @returns {Promise<{id: string, label: string}[]>}
 */
export async function listBookmarkFolders() {
  const [tree] = await chrome.bookmarks.getTree();
  const folders = [];
  const walk = (node, trail) => {
    for (const child of node.children || []) {
      if (!isFolder(child) || child.unmodifiable) continue;
      const label = [...trail, child.title].join(" › ");
      folders.push({ id: child.id, label });
      walk(child, [...trail, child.title]);
    }
  };
  walk(tree, []);
  return folders;
}
