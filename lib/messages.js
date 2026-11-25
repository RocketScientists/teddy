// Message types sent between the popup, the offscreen page and the background service worker.
export const MESSAGE = {
  classifySelected: "classify-selected",
  restoreSavedGroup: "restore-saved-group",
  // Worker → offscreen page: put `text` on the clipboard.
  copyToClipboard: "copy-to-clipboard",
};
