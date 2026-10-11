'use strict';

// Общий слой для Firefox (browser.*, MV2) и Chrome (chrome.*, MV3).
const IS_FIREFOX = typeof globalThis.browser !== 'undefined' &&
  typeof globalThis.browser.runtime?.getBrowserInfo === 'function';

if (typeof globalThis.browser === 'undefined') globalThis.browser = chrome;

// Chrome не принимает Promise из onMessage-обработчика — отвечаем через sendResponse.
function onMessage(handler) {
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    let r;
    try {
      r = handler(msg, sender);
    } catch (e) {
      sendResponse({ error: e && e.message || String(e) });
      return false;
    }
    if (r && typeof r.then === 'function') {
      r.then(sendResponse, e => sendResponse({ error: e && e.message || String(e) }));
      return true;
    }
    if (r !== undefined && r !== false) sendResponse(r);
    return false;
  });
}
