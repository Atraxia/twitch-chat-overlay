// Menu clic droit : « Surligner / ne plus surligner ce pseudo » sur Twitch.
// Le pseudo est retenu par le content script au moment du clic droit.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "tct-highlight",
      title: "Surligner / ne plus surligner ce pseudo",
      contexts: ["all"],
      documentUrlPatterns: ["https://www.twitch.tv/*"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "tct-highlight" && tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: "toggleHighlight" });
  }
});
