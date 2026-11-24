import { loadSettings, validateSettings } from "./lib/settings.js";
import { MESSAGE } from "./lib/messages.js";
import { listSavedGroups } from "./lib/bookmarks.js";

const btn = document.getElementById("classify");
const status = document.getElementById("status");
const list = document.getElementById("results");

// The worker clears the badge on a timer, but the timer is lost if Chrome
// stops the worker first; opening the popup always clears a stale badge.
chrome.action.setBadgeText({ text: "" });

document.getElementById("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

loadSettings().then((settings) => {
  const settingsProblem = validateSettings(settings);
  if (settingsProblem) {
    status.textContent = settingsProblem;
    status.className = "error";
  }
});

btn.addEventListener("click", async () => {
  btn.disabled = true;
  list.innerHTML = "";
  status.className = "";
  status.textContent = "Classifying…";

  const res = await chrome.runtime.sendMessage({ type: MESSAGE.classifySelected });
  btn.disabled = false;

  if (!res?.ok) {
    status.className = "error";
    status.textContent = res?.error || "Unknown error";
    return;
  }

  for (const r of res.results) {
    const li = document.createElement("li");
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = r.title || `Tab ${r.tabId}`;
    const outcome = document.createElement("span");
    outcome.className = r.ok ? "group" : "error";
    outcome.textContent = r.ok ? `→ ${r.group}` : `✗ ${r.error}`;
    li.append(title, outcome);
    list.append(li);
  }
  const failed = res.results.filter((r) => !r.ok).length;
  status.textContent = failed ? `${failed} tab(s) failed.` : "Done.";
  status.className = failed ? "error" : "";
});

// Saved groups: the folder tree under the root folder, with a Restore button
// on each folder that has bookmarks of its own.
const savedRoot = document.getElementById("saved-root");
const savedList = document.getElementById("saved-groups");
const restoreStatus = document.getElementById("restore-status");

async function showSavedGroups() {
  savedList.innerHTML = "";
  const saved = await listSavedGroups();
  if (!saved?.groups.length) {
    savedRoot.textContent = "Nothing saved yet. Right-click a page → Save tab group to bookmarks.";
    return;
  }
  savedRoot.textContent = `In the "${saved.root}" bookmark folder:`;
  for (const group of saved.groups) {
    const li = document.createElement("li");
    li.className = "saved-group";
    li.style.paddingLeft = `${group.depth * 14}px`;
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = group.title;
    li.append(title);
    if (group.count) {
      const restore = document.createElement("button");
      restore.className = "restore";
      restore.textContent = `Restore (${group.count})`;
      restore.addEventListener("click", () => restoreSaved(group.id, restore));
      li.append(restore);
    }
    savedList.append(li);
  }
}

async function restoreSaved(folderId, button) {
  button.disabled = true;
  restoreStatus.className = "";
  restoreStatus.textContent = "Restoring…";
  const { id: windowId } = await chrome.windows.getCurrent();
  const res = await chrome.runtime.sendMessage({ type: MESSAGE.restoreSavedGroup, folderId, windowId });
  button.disabled = false;
  if (!res?.ok) {
    restoreStatus.className = "error";
    restoreStatus.textContent = res?.error || "Unknown error";
    return;
  }
  const parts = [`Opened ${res.opened} tab(s) in "${res.name}".`];
  if (res.skipped) parts.push(`${res.skipped} already open.`);
  if (res.failed) parts.push(`${res.failed} couldn't be opened.`);
  restoreStatus.className = res.failed ? "error" : "";
  restoreStatus.textContent = parts.join(" ");
}

showSavedGroups().catch((err) => {
  savedRoot.className = "error";
  savedRoot.textContent = String(err?.message || err);
});
