import { loadSettings } from "./lib/settings.js";

const btn = document.getElementById("classify");
const status = document.getElementById("status");
const list = document.getElementById("results");

document.getElementById("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

loadSettings().then((s) => {
  if (!s.apiKey && s.apiBaseUrl.includes("api.openai.com")) {
    status.textContent = "Set your API key in Settings first.";
    status.className = "error";
  }
});

btn.addEventListener("click", async () => {
  btn.disabled = true;
  list.innerHTML = "";
  status.className = "";
  status.textContent = "Classifying…";

  const res = await chrome.runtime.sendMessage({ type: "classify-selected" });
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
