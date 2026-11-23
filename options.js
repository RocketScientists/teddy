import { loadSettings, saveSettings } from "./lib/settings.js";

const form = document.getElementById("form");
const saved = document.getElementById("saved");

loadSettings().then((settings) => {
  for (const [key, value] of Object.entries(settings)) {
    if (form.elements[key]) form.elements[key].value = value;
  }
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
  });
  saved.textContent = "Saved ✓";
  setTimeout(() => (saved.textContent = ""), 2000);
});
