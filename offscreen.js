// Runs in the hidden offscreen page. A service worker can't touch the
// clipboard, and navigator.clipboard needs a focused page, which this never is,
// so it copies with a textarea and execCommand("copy"). Without a user gesture
// on the page, that only works with the "clipboardWrite" permission.
import { MESSAGE } from "./lib/messages.js";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== MESSAGE.copyToClipboard) return;
  const field = document.getElementById("text");
  field.value = msg.text;
  field.select();
  const ok = document.execCommand("copy");
  field.value = "";
  sendResponse(ok ? { ok: true } : { ok: false, error: "The browser refused to copy." });
});
