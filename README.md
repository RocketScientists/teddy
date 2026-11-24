# Teddy (MVP)

A Chrome extension (Manifest V3) that sorts the selected tab(s) into tab groups.
It sends each tab's title, URL and a short excerpt of the page text to any
**OpenAI-compatible Chat Completions API** and moves the tab into the group the
model picks — reusing an existing group in the window, or creating a new one.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Open the extension's **Settings** (popup → Settings, or right-click the icon → Options) and set:
   - **API base URL** – e.g. `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, `http://localhost:11434/v1` (Ollama)
     - Ollama rejects requests from browser extensions by default (HTTP 403). Start it with
       `OLLAMA_ORIGINS="chrome-extension://*" ollama serve` (or set that variable for the Ollama app).
   - **API key** – stored in `chrome.storage.local`, never synced
   - **Model** – e.g. `gpt-4o-mini`
   - Optional **preferred group names** to steer the model toward your own categories
   - Optional **New tabs** settings – see [New tab position](#new-tab-position)

## Use

- Select one tab (or several with Shift/Ctrl/Cmd-click), then click the toolbar icon → **Classify selected tab(s)**.
- Or press **Alt+Shift+G** (change at `chrome://extensions/shortcuts`).
- Or right-click a page → **Classify tab into group**.

The shortcut and context menu show a badge on the icon: ✓ for success, ! for failure (details in the service worker console).

### New tab position

Chrome sometimes opens new tabs at the end of the tab strip and sometimes next
to the current tab. In **Settings → New tabs** you can force new tabs to open
at the **start** (just after pinned tabs) or the **end**. This applies to tabs
from the new-tab shortcut and from other apps; tabs opened from a link stay
next to their opener unless you tick **Also move tabs opened from a link**.
Pinned tabs and tabs Chrome puts in a group are never moved.

Restored tabs are left where Chrome puts them: reopened closed tabs
(Ctrl/Cmd+Shift+T), restored windows, and tabs restored at startup or after a
crash. Chrome doesn't mark restored tabs, so Teddy treats a new tab as restored
if its window opened in the last 2 seconds, or if its URL matches a tab closed
in the last 30 minutes. As a result, a link from another app to a page you
closed recently opens where Chrome puts it.

## How it works

| File | Role |
| --- | --- |
| `background.js` | Service worker: gets the selected tabs, extracts page text via `chrome.scripting`, calls the LLM, groups tabs |
| `lib/llm.js` | Builds the prompt, calls `POST {base}/chat/completions`, parses `{"group","color"}` JSON |
| `lib/settings.js` | Settings defaults and storage |
| `lib/tab-position.js` | Moves new tabs to the start or end of the tab strip |
| `popup.*`, `options.*` | UI |

Tabs are classified one at a time so a group created for one tab is offered as
an "existing group" for the next. Pages that can't be scripted (`chrome://`,
the Web Store, the PDF viewer) are classified by title and URL only.

## Privacy note

Page text (up to the configured character limit) is sent to whichever API
endpoint you configure. Use a local model endpoint if that matters to you.

## Ideas beyond the MVP

- "Classify all ungrouped tabs" button
- Auto-classify new tabs on load
- Cache results per domain to save API calls
- Use `response_format: {type: "json_object"}` where the provider supports it
