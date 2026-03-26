// background.js - SmartWords v2.0
// 只负责右键菜单（打开设置页）

chrome.runtime.onInstalled.addListener(async () => {
  await new Promise(r => chrome.contextMenus.removeAll(r));
  await new Promise(r => chrome.contextMenus.create({
    id: 'sw-settings',
    title: '⚙️ Kody 设置',
    contexts: ['action']
  }, r));
});

// service worker 重启时也重建菜单
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'sw-settings')
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
});
