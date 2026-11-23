const DEFAULT_SETTINGS = {
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  // Max characters of page text sent to the model.
  maxContentChars: 3000,
  // Optional newline-separated list of preferred group names.
  categories: "",
};

export async function loadSettings() {
  // Passing the defaults to get() fills in any key that isn't stored yet.
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

export async function saveSettings(settings) {
  await chrome.storage.local.set(settings);
}

/**
 * One place that decides whether settings are usable.
 * @returns {string|null} a message describing the problem, or null if settings are usable
 */
export function validateSettings(settings) {
  if (!settings.apiBaseUrl || !settings.model) {
    return "Set the API base URL and model in Settings first.";
  }
  if (!settings.apiKey && settings.apiBaseUrl.includes("api.openai.com")) {
    return "Set your API key in Settings first.";
  }
  return null;
}

export function parseCategories(text) {
  return (text || "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
