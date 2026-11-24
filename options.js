import { loadSettings, saveSettings } from "./lib/settings.js";
import { listBookmarkFolders } from "./lib/bookmarks.js";

const form = document.getElementById("form");
const saved = document.getElementById("saved");

async function fillFolderList() {
  const select = form.elements.bookmarkRootId;
  for (const { id, label } of await listBookmarkFolders()) {
    select.append(new Option(label, id));
  }
}

Promise.all([loadSettings(), fillFolderList()]).then(([settings]) => {
  for (const [key, value] of Object.entries(settings)) {
    const field = form.elements[key];
    if (!field) continue;
    if (field.type === "checkbox") field.checked = Boolean(value);
    else field.value = value;
  }
  // A chosen root folder that was deleted shows (and acts as) the default.
  const root = form.elements.bookmarkRootId;
  if (root.value !== settings.bookmarkRootId) root.value = "";
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fields = form.elements;
  await saveSettings({
    apiBaseUrl: fields.apiBaseUrl.value.trim(),
    apiKey: fields.apiKey.value.trim(),
    model: fields.model.value.trim(),
    maxContentChars: Number(fields.maxContentChars.value) || 0,
    categories: fields.categories.value,
    newTabPosition: fields.newTabPosition.value,
    moveTabsOpenedFromLinks: fields.moveTabsOpenedFromLinks.checked,
    bookmarkRootId: fields.bookmarkRootId.value,
    // Not trimmed: spaces are part of the separator.
    groupSeparator: fields.groupSeparator.value,
  });
  saved.textContent = "Saved ✓";
  setTimeout(() => (saved.textContent = ""), 2000);
});
