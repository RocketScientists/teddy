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
   - Optional **Bookmarks** settings – see [Save and restore tab groups](#save-and-restore-tab-groups)

## Use

- Select one tab (or several with Shift/Ctrl/Cmd-click), then click the toolbar icon → **Classify selected tab(s)**.
- Or press **Alt+Shift+G** (change at `chrome://extensions/shortcuts`).
- Or right-click a page → **Classify tab into group**.

The shortcut and context menu show a badge on the icon: ✓ for success, ! for failure (details in the service worker console).

### Move tabs to the start or end

Right-click a page (or the Teddy toolbar icon) → **Move tab(s) to start of tab
strip** or **Move tab(s) to end of tab strip**. If the tab is part of a
multi-selection, all selected tabs move together and keep their order. Pinned
tabs move to the start or end of the pinned area. Grouped tabs leave their
group, and a moved tab never joins the group it lands next to. On the page menu
Chrome puts Teddy's items in a **Teddy** submenu. Chrome doesn't let extensions
add items to the menu you get by right-clicking a tab itself.

Keyboard shortcuts do the same for the selected tab(s): **Alt+Shift+Home** (start)
and **Alt+Shift+End** (end). On a Mac laptop, Home and End are **fn+←** and
**fn+→**. Change them at `chrome://extensions/shortcuts`.

### Save and restore tab groups

Right-click a page (or the Teddy toolbar icon) → **Save tab group to bookmarks**
saves the current tab's group, and **Save all tab groups in window to
bookmarks** saves every named group in the window. Both are also keyboard
commands with no default key; assign one at `chrome://extensions/shortcuts`.
Tabs stay open. The first menu item shows the name of the group it will save,
for example **Save tab group "Project/ABC" to bookmarks**, and is greyed out
when the current tab isn't in a named group. Chrome doesn't tell extensions
which group header you clicked, so click a tab inside the group first.

Each group becomes a bookmark folder under the root folder ("Teddy" in Other
bookmarks unless you pick another in **Settings → Bookmarks**). The group name
is split on the **group separator** (default `/`) into nested folders, so the
group "Project/ABC" is saved to `Teddy › Project › ABC`. Parts are trimmed and
empty ones dropped. Saving again replaces the folder's bookmarks with the
group's current tabs, in order; bookmarks you added to that folder by hand are
removed, and subfolders are never touched. Unnamed groups can't be saved. The
group's colour is remembered and used when it is restored.

To restore, open the Teddy popup: **Saved groups** lists the folders under the
root folder, and each folder with bookmarks has a **Restore** button. Restore
opens that folder's bookmarks (not its subfolders) as background tabs in the
current window. If the window already has a group with the same name (ignoring
case and spaces around the separator), the bookmarks that aren't open in it yet
are added to it. Otherwise a new group named by joining the folders with the
separator ("Project/ABC") is created where new tabs open: at the start of the
tab strip (after pinned tabs) if **Settings → New tabs** says start, otherwise
at the end. Teddy never
deletes saved groups; do that in Chrome's bookmark manager.

Changing the separator doesn't rename folders you've already saved; it only
affects later saves and restores.

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

To see why a new tab wasn't moved, open the service worker console from the
extension card, turn on the **Verbose** log level, and look for
"Teddy: left new tab … alone".

## How it works

| File | Role |
| --- | --- |
| `background.js` | Service worker: gets the selected tabs, extracts page text via `chrome.scripting`, calls the LLM, groups tabs |
| `lib/llm.js` | Builds the prompt, calls `POST {base}/chat/completions`, parses `{"group","color"}` JSON |
| `lib/settings.js` | Settings defaults and storage |
| `lib/bookmarks.js` | Saves tab groups as bookmark folders and restores them |
| `lib/save-menu-title.js` | Keeps the "Save tab group" menu item showing the current group's name |
| `lib/tab-move.js` | Moves tabs to the start or end of the tab strip |
| `lib/new-tab-position.js` | The "New tabs" setting: moves new tabs as they open, leaving restored tabs alone |
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
