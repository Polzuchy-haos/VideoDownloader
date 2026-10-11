'use strict';

// Работает во всех фреймах (изолированный мир content script).
// 1) Отвечает на «пинг» панели выбора плеера — так фон узнаёт frameId выбранного iframe
//    (в Chrome нет runtime.getFrameId).
// 2) Chrome: передаёт в фон ответы, перехваченные content/hook.js в странице плеера.
(() => {
  if (window.__dcdlRelay) return;
  window.__dcdlRelay = true;

  const api = globalThis.browser || globalThis.chrome;
  const send = msg => {
    try {
      const p = api.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(() => {});
    } catch {}
  };

  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.__dcdlPing && window !== window.top) {
      send({ type: 'frameHello', token: String(d.__dcdlPing) });
    } else if (d.__dcdlSniff && e.source === window && typeof d.text === 'string') {
      send({ type: 'sniffed', url: String(d.url || location.href), text: d.text });
    }
  });

  // Настройка «глубокий анализ на всех сайтах» для перехватчика в странице.
  try {
    const p = api.storage.local.get('settings');
    if (p && p.then) {
      p.then(r => {
        if (r && r.settings && r.settings.deepSniffAll) window.postMessage({ __dcdlCfg: true, all: true }, '*');
      }).catch(() => {});
    }
  } catch {}
})();
