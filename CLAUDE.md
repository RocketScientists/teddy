# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Teddy is a Chrome MV3 extension that classifies tabs into tab groups with an OpenAI-compatible LLM. README.md covers what it does, how to install it, its settings and the Ollama setup. Read it first.

## Development

There is no build step, package manager, linter or test suite. Chrome loads the plain ES module files directly.

- After editing, click the reload icon on the extension card in `chrome://extensions`. Popup and options pages pick up changes the next time they open.
- Debug the background logic from the "service worker" link on the extension card. Failures from the shortcut and context menu are only logged there. The toolbar badge shows only "…" while a run is in progress, then ✓ or !.

## Architecture

- **`background.js`** (module service worker) handles classification. The popup message, the `classify-selected-tabs` command and the `classify-tab` context menu all call `classifyTabs()`. It also calls `startTabPositioning()` from `lib/tab-position.js` at the top level, because MV3 listeners must be registered synchronously.
  - `classifyTabs()` puts each run on a single promise chain (`runQueue`), so overlapping triggers can't both create a group with the same name. New entry points must call `classifyTabs()`. Never call `classifyTabsNow()` directly, because that skips the queue.
  - Within a run, tabs are classified **one at a time, on purpose**. The tab-group list is queried again for each tab, so a group created for one tab is offered to the model as an "existing group" for the next. Don't run them in parallel.
  - Page text comes from `chrome.scripting.executeScript`. If injection fails (restricted pages, discarded tabs), the tab is classified by title and URL only.
  - Group matching ignores case (`moveTabToGroup`). Pinned tabs fail on purpose because Chrome can't group them.
  - Selected tabs are found with `lastFocusedWindow: true`, because a service worker has no current window.
  - The `onMessage` handler returns `true` so it can send the popup its reply after the async run finishes.
- **`lib/llm.js`** builds the prompt, calls `{apiBaseUrl}/chat/completions` (30-second timeout) and parses the reply.
  - Page content is wrapped in `<page>…</page>` and the system prompt marks it as untrusted. `stripPageTags` removes those tags from page data so a page can't end the block early. Keep this prompt-injection guard in place if you change the prompt.
  - `extractFirstJsonObject` finds the first balanced `{…}` that parses as JSON. It skips braces inside JSON strings, and stray or non-JSON braces in prose before or after the object, so the reply can contain code fences or commentary. `parseClassification` then truncates the group name to 40 characters and changes any color outside Chrome's tab-group palette (`GROUP_COLORS`) to `grey`.
- **`lib/tab-position.js`** is the optional "New tabs" feature. On `tabs.onCreated` it moves a tab to the start of the strip (after pinned tabs) or the end, and it is unrelated to classification.
  - Tabs with an `openerTabId` came from a link and stay next to their opener unless `moveTabsOpenedFromLinks` is on. The new-tab page always counts as new. Pinned and grouped tabs are never moved.
  - Restored tabs also fire `onCreated` with no opener, but Chrome doesn't mark them as restored. The module skips a tab if its window was created in the last 2 seconds (window, session or crash restore), or if its URL matches a recently closed tab (reopen closed tab). Closed URLs are recorded by keeping an in-memory map of tab ID to URL, refilled with `tabs.query` whenever the worker starts, because `onRemoved` doesn't include the URL. The recently-closed list lives in `chrome.storage.session` so it survives the worker stopping, and its updates go through one promise queue. New-tab and blank pages are never recorded, otherwise a new tab would look reopened.
  - `tabs.move` fails while the user drags a tab, so the move retries a few times, detecting this by matching Chrome's English error text.
- **`lib/settings.js`** holds the settings defaults. Settings are stored in `chrome.storage.local`, never synced, because they include the API key. `validateSettings` is the only check for whether settings are usable; both the popup and the worker call it.
- **`lib/messages.js`** lists the message-type constants shared by the popup and the worker.
- **`popup.js`** clears the badge when it opens. The worker's 3-second clear timer is lost if Chrome stops the worker first.
