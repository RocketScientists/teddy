# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Teddy is a Chrome MV3 extension that classifies tabs into tab groups with an OpenAI-compatible LLM. It can also move tabs to the start or end of the tab strip, on demand or as new tabs open, and save tab groups as bookmark folders and restore them. README.md covers what it does, how to install it, its settings and the Ollama setup. Read it first. GLOSSARY.md defines the terms for saving and restoring groups (group path, root folder, saved group); use them.

## Development

There is no build step, package manager, linter or test suite. Chrome loads the plain ES module files directly.

- After editing, click the reload icon on the extension card in `chrome://extensions`. Popup and options pages pick up changes the next time they open.
- Debug the background logic from the "service worker" link on the extension card. Failures from shortcuts and context-menu items are only logged there. The toolbar badge shows only "…" while a run is in progress, then ✓ or !.

## Architecture

- **`background.js`** (module service worker) wires up every trigger and handles classification.
  - The `ACTIONS` table drives both context menus and keyboard shortcuts. Each key is the menu item ID and, where the action has a shortcut, the command name in `manifest.json`. A key must match the manifest exactly. Add new menu items or shortcuts there.
  - Every menu and shortcut action goes through `runWithBadge`, which shows "…" and then ✓ or !. `run(tab)` gets the tab the menu was opened on, or `undefined` for a shortcut, and returns per-tab results or nothing.
  - The move actions act on the whole selection in the clicked tab's window. The menu's tab is always the active tab, and the active tab is always highlighted.
  - It calls `startNewTabPositioning()` at the top level, because MV3 listeners must be registered synchronously.
  - `classifyTabs()` puts each run on a single promise chain (`runQueue`), so overlapping triggers can't both create a group with the same name. New entry points must call `classifyTabs()`. Never call `classifyTabsNow()` directly, because that skips the queue.
  - Within a run, tabs are classified **one at a time, on purpose**. The tab-group list is queried again for each tab, so a group created for one tab is offered to the model as an "existing group" for the next. Don't run them in parallel.
  - Page text comes from `chrome.scripting.executeScript`. If injection fails (restricted pages, discarded tabs), the tab is classified by title and URL only.
  - Group matching ignores case (`moveTabToGroup`). Pinned tabs fail on purpose because Chrome can't group them.
  - Selected tabs are found with `lastFocusedWindow: true`, because a service worker has no current window.
  - The `onMessage` handler returns `true` so it can send the popup its reply after the async run finishes.
- **`lib/llm.js`** builds the prompt, calls `{apiBaseUrl}/chat/completions` (30-second timeout) and parses the reply.
  - Page content is wrapped in `<page>…</page>` and the system prompt marks it as untrusted. `stripPageTags` removes those tags from page data so a page can't end the block early. Keep this prompt-injection guard in place if you change the prompt.
  - `extractFirstJsonObject` finds the first balanced `{…}` that parses as JSON. It skips braces inside JSON strings, and stray or non-JSON braces in prose before or after the object, so the reply can contain code fences or commentary. `parseClassification` then truncates the group name to 40 characters and changes any color outside Chrome's tab-group palette (`GROUP_COLORS`) to `grey`.
- **`lib/tab-move.js`** provides `moveTabsToEdge(tabs, EDGE.start|EDGE.end)`, used by the move actions and by the New tabs feature.
  - Moved tabs keep their order. Pinned tabs stay in the pinned area. Grouped tabs are ungrouped first, and any tab that lands inside a group is ungrouped again.
  - Use index `-1` for "end", never a computed index. `tabs.move` with several IDs adds 1 to a fixed index after each tab, which scrambles the order.
- **`lib/new-tab-position.js`** is the optional "New tabs" setting. On `tabs.onCreated` it calls `moveTabsToEdge`, and it is unrelated to classification.
  - Tabs with an `openerTabId` came from a link and stay next to their opener unless `moveTabsOpenedFromLinks` is on. The new-tab page always counts as new. Pinned and grouped new tabs are never moved.
  - Restored tabs also fire `onCreated` with no opener, but Chrome doesn't mark them as restored. The module skips a tab if its window was created in the last 2 seconds (window, session or crash restore), or if its URL matches a recently closed tab (reopen closed tab). Closed URLs are recorded by keeping an in-memory map of tab ID to URL, refilled with `tabs.query` whenever the worker starts, because `onRemoved` doesn't include the URL. The recently-closed list lives in `chrome.storage.session` so it survives the worker stopping, and its updates go through one promise queue. New-tab and blank pages are never recorded, otherwise a new tab would look reopened.
- **`lib/bookmarks.js`** saves a tab group to a bookmark folder and restores one. The save actions in `ACTIONS` call `saveGroup`, and the popup lists saved groups itself (`listSavedGroups`) but sends restores to the worker (`MESSAGE.restoreSavedGroup`).
  - A group name is split on the `groupSeparator` setting into a group path. Parts are trimmed and empty parts dropped. Folder names and group names match ignoring case.
  - A save replaces only the folder's direct bookmarks, and creates the new ones before removing the old ones. Subfolders are other saved groups, so never touch them.
  - Saves and restores share one promise queue, so overlapping saves can't create the same folder twice.
  - The root folder is the `bookmarkRootId` setting if that folder still exists, otherwise "Teddy" under "Other bookmarks", created on the first save. Group colours are kept in `chrome.storage.local` under `savedGroupColors`, keyed by folder ID, because bookmarks can't store them.
  - Chrome's context menus have no bookmark context, so restore happens only from the popup.
- **`lib/save-menu-title.js`** retitles the "save-tab-group" menu item with the active tab's group name, and disables it when that tab has no named group. Chrome has no "menu shown" event and no selected state for a group header, so it listens to tab activation, `groupId` changes on the active tab, group updates and removals, and window focus. `startSaveMenuTitle()` is called at the top level, and `onInstalled` refreshes the title again after it creates the menu items.
- Tab edits (`tabs.move`, `tabs.ungroup`) fail while the user drags a tab, so `lib/tab-move.js` retries them a few times. It detects this by matching Chrome's English error text.
- **`lib/settings.js`** holds the settings defaults. Settings are stored in `chrome.storage.local`, never synced, because they include the API key. `validateSettings` is the only check for whether settings are usable; both the popup and the worker call it.
- **`lib/messages.js`** lists the message-type constants shared by the popup and the worker.
- **`popup.js`** clears the badge when it opens. The worker's 3-second clear timer is lost if Chrome stops the worker first.
