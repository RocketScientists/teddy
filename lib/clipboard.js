// Copying text from the service worker, through a hidden offscreen page
// (offscreen.html), because a service worker has no clipboard access.

import { MESSAGE } from "./messages.js";

const OFFSCREEN_URL = "offscreen.html";

// Copies run one after another, so two quick presses can't both try to create
// the offscreen page (Chrome allows only one).
let queue = Promise.resolve();

/** Put `text` on the clipboard. Throws if it couldn't be copied. */
export function copyText(text) {
  const run = queue.then(() => copyNow(text));
  queue = run.catch(() => {});
  return run;
}

async function copyNow(text) {
  await ensureOffscreenPage();
  const reply = await chrome.runtime.sendMessage({ type: MESSAGE.copyToClipboard, text });
  if (!reply?.ok) throw new Error(reply?.error || "Couldn't copy to the clipboard.");
}

async function ensureOffscreenPage() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["CLIPBOARD"],
    justification: "Copy the current tab's URL to the clipboard.",
  });
}
