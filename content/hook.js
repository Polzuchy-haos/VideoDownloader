'use strict';

// Только Chrome (world: MAIN). Аналог filterResponseData из Firefox: перехватывает ответы
// fetch/XHR внутри плееров и на страницах аниме-сайта и передаёт подходящие тексты
// (m3u8, JSON API плееров, конфиги) в content/relay.js через postMessage.
(() => {
  const FLAG = Symbol.for('dcdl.hook');
  if (window[FLAG]) return;
  window[FLAG] = true;

  const SITES = /(^|\.)(yummyani\.me|yummy-anime\.ru|yummyanime\.tv|yummy-anime\.com|yummyanime\.club)$/i;
  const PLAYERS = /kodik|aniqit|anivod|alloha|newplayjj|stloadi|cdnvideohub|(^|\.)cvh/i;
  const SKIP = /\.(ts|m4s|m4a|aac|mp4|webm|jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf)(\?|#|$)/i;
  const MAX = 1536 * 1024;

  const topHost = (() => {
    try {
      const ao = location.ancestorOrigins;
      if (ao && ao.length) return new URL(ao[ao.length - 1]).host;
    } catch {}
    return location.host;
  })();
  const baseActive = SITES.test(topHost) || PLAYERS.test(location.host);
  let all = false;
  const active = () => baseActive || all;

  window.addEventListener('message', e => {
    if (e.source === window && e.data && e.data.__dcdlCfg) all = !!e.data.all;
  });

  function interesting(text) {
    if (typeof text !== 'string' || !text || text.length > MAX) return false;
    const h = text.slice(0, 64).trimStart();
    return h.startsWith('#EXTM3U') || h.startsWith('{') || h.startsWith('[') || /\.(m3u8|mpd|mp4)/i.test(text);
  }

  function report(url, text) {
    try {
      if (interesting(text)) window.postMessage({ __dcdlSniff: true, url: String(url), text }, '*');
    } catch {}
  }

  // fetch
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      if (active()) {
        p.then(r => {
          try {
            const url = r.url || (args[0] && args[0].url) || String(args[0]);
            if (SKIP.test(url)) return;
            const ct = r.headers.get('content-type') || '';
            const len = +r.headers.get('content-length') || 0;
            if (/video|audio|image|font|mp2t/i.test(ct) || len > MAX) return;
            if (/octet-stream/i.test(ct) && !(len && len < 512 * 1024)) return;
            r.clone().text().then(t => report(url, t), () => {});
          } catch {}
        }, () => {});
      }
      return p;
    };
  }

  // XMLHttpRequest
  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR) {
    const urls = new WeakMap();
    const origOpen = XHR.open;
    const origSend = XHR.send;
    XHR.open = function (method, url) {
      try { urls.set(this, url); } catch {}
      return origOpen.apply(this, arguments);
    };
    XHR.send = function () {
      if (active()) {
        this.addEventListener('load', function () {
          try {
            const url = this.responseURL || urls.get(this) || '';
            if (SKIP.test(url)) return;
            const rt = this.responseType;
            if (rt === '' || rt === 'text') report(url, this.responseText);
            else if (rt === 'json' && this.response) report(url, JSON.stringify(this.response));
          } catch {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  // Встроенные скрипты страницы плеера (ссылки/конфиги Playerjs прямо в HTML).
  if (active()) {
    document.addEventListener('DOMContentLoaded', () => {
      try {
        const text = [...document.scripts].filter(s => !s.src).map(s => s.textContent).join('\n');
        if (/\.(m3u8|mpd|mp4)/i.test(text)) report(location.href, text.slice(0, MAX));
      } catch {}
    });
  }
})();
