import { loadSettings, saveSettings } from "./lib/settings.js";

const form = document.getElementById("form");
const saved = document.getElementById("saved");

loadSettings().then((s) => {
  for (const [key, value] of Object.entries(s)) {
    if (form.elements[key]) form.elements[key].value = value;
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = form.elements;
  await saveSettings({
    apiBaseUrl: f.apiBaseUrl.value.trim(),
    apiKey: f.apiKey.value.trim(),
    model: f.model.value.trim(),
    maxContentChars: Number(f.maxContentChars.value) || 0,
    categories: f.categories.value,
  });
  saved.textContent = "Saved ✓";
  setTimeout(() => (saved.textContent = ""), 2000);
});
