# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Teddy is a Chrome Manifest V3 extension that sorts the selected tab(s) into tab groups. For each tab it sends the title, URL and a page-text excerpt to an OpenAI-compatible Chat Completions API (`POST {apiBaseUrl}/chat/completions`). The model replies with `{"group","color"}`, and the extension joins an existing group with that name or creates a new one.

## Development

There is no build step, package manager, linter or test suite. All files are plain ES modules that Chrome loads directly.

- Run: `chrome://extensions` → Developer mode → **Load unpacked** → this folder. After editing, click the reload icon on the extension card. Popup and options pages pick up changes the next time they open.
- Debug the background logic from the "service worker" link on the extension card. Shortcut and context-menu failures are only logged there; the toolbar badge just shows ✓ or !.
- Local Ollama (`http://localhost:11434/v1`) returns 403 to extensions unless started with `OLLAMA_ORIGINS="chrome-extension://*" ollama serve`.

## Architecture

- **`background.js`** (module service worker) does all the work. There are three triggers: the popup sends a message, the `classify-selected-tabs` command (Alt+Shift+G) fires, or the `classify-tab` context menu is clicked. All three call `classifyTabs()`.
  - Runs go through a single promise chain (`runQueue`), so overlapping triggers can't both create a group with the same name. Keep new entry points on this queue.
  - Within a run, tabs are classified **one at a time, on purpose**. The tab-group list is queried again for each tab, so a group created for one tab is offered to the model as an "existing group" for the next. Running tabs in parallel would break this.
  - Page text comes from `chrome.scripting.executeScript`. Pages that can't be scripted (`chrome://`, the Web Store, the PDF viewer, discarded tabs) are classified by title and URL only.
  - Group matching ignores case (`moveTabToGroup`). Pinned tabs fail on purpose because Chrome can't group them.
  - Selected tabs are found with `lastFocusedWindow: true`, because a service worker has no current window.
- **`lib/llm.js`** builds the prompt, calls the API and parses the reply.
  - Page content is wrapped in `<page>…</page>` and the system prompt marks it as untrusted. `stripPageTags` removes those tags from page data so a page can't end the block early. Keep this prompt-injection guard in place if you change the prompt.
  - `parseClassification` takes the first `{...}` in the reply (so code fences or extra prose are fine), truncates the group name to 40 characters, and changes any color outside Chrome's tab-group palette (`GROUP_COLORS`) to `grey`.
  - Requests time out after 30 seconds.
- **`lib/settings.js`** holds the settings defaults (`chrome.storage.local`, never synced, because it stores the API key). `validateSettings` is the only check for whether settings are usable; both the popup and the worker call it. `parseCategories` splits the user's preferred group names on newlines and commas.
- **`lib/messages.js`** lists the message-type constants shared by the popup and the worker. The worker's `onMessage` handler returns `true` so it can send its reply after async work.
- **`popup.*` / `options.*`** are thin UI. The popup clears the badge when it opens, because the worker's 3-second clear timer is lost if Chrome stops the worker.
