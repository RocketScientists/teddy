export const DEFAULT_SETTINGS = {
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  // Max characters of page text sent to the model.
  maxContentChars: 3000,
  // Optional newline-separated list of preferred group names.
  categories: "",
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set(settings);
}

export function parseCategories(text) {
  return (text || "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
