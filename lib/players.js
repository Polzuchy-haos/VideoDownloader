'use strict';

// Определение плеера по URL фрейма/запроса и извлечение ссылок на видео из ответов плееров.
const Players = (() => {
  // Домены меняются — при необходимости дополните регулярки.
  const LIST = [
    { id: 'kodik', name: 'Kodik', re: /kodik|aniqit|anivod/i },
    { id: 'alloha', name: 'Alloha', re: /alloha|newplayjj|stloadi/i },
    { id: 'cvh', name: 'CVH', re: /cdnvideohub|(^|[./])cvh/i },
  ];

  function byHost(url) {
    const host = U.hostOf(url);
    if (!host) return null;
    return LIST.find(p => p.re.test(host)) || null;
  }

  // details — объект webRequest (Firefox): documentUrl, frameAncestors, url.
  function detect(details) {
    const candidates = [details.documentUrl, details.originUrl, details.url];
    for (const fa of details.frameAncestors || []) candidates.push(fa.url);
    for (const u of candidates) {
      const p = u && byHost(u);
      if (p) return { id: p.id, name: p.name };
    }
    const host = U.hostOf(details.documentUrl || details.url) || 'unknown';
    return { id: 'other', name: host };
  }

  function isKnownPlayerRequest(details) {
    return detect(details).id !== 'other';
  }

  const URL_RE = /^(https?:)?\/\/[^\s"'<>]+$/i;

  // Kodik отдаёт ссылки в base64, предварительно «прокрученном» шифром Цезаря (сдвиг менялся со временем).
  function decodeMaybeEncodedUrl(s) {
    if (typeof s !== 'string') return null;
    s = s.trim();
    if (URL_RE.test(s)) return s;
    if (s.length < 16 || s.length > 4000 || /[^A-Za-z0-9+/=_-]/.test(s)) return null;
    const direct = U.b64decode(s);
    if (direct && URL_RE.test(direct)) return direct;
    for (let k = 1; k < 26; k++) {
      const d = U.b64decode(U.caesar(s, k));
      if (d && URL_RE.test(d)) return d;
    }
    return null;
  }

  function classify(url, key = '') {
    const p = U.stripQuery(url);
    if (/\.m3u8$/i.test(p) || /:hls:manifest/i.test(p)) return 'hls';
    if (/\.mpd$/i.test(p)) return 'dash';
    if (/\.(mp4|m4v|webm|mkv)$/i.test(p)) return 'direct';
    key = String(key);
    if (/hls/i.test(key)) return 'hls';
    if (/dash/i.test(key)) return 'dash';
    if (/^(mpeg|mp4)|(mpeg|mp4)\w*url$/i.test(key)) return 'direct';
    return null;
  }

  function labelFromPath(path) {
    for (let i = path.length - 1; i >= 0; i--) {
      const k = String(path[i]);
      const m = k.match(/^(\d{3,4})p?$/);
      if (m) return m[1] + 'p';
    }
    for (let i = path.length - 1; i >= 0; i--) {
      if (typeof path[i] === 'string' && !/^(src|url|file|link)$/i.test(path[i])) return path[i];
    }
    return '';
  }

  function scanJson(root, found) {
    const walk = (v, path) => {
      if (v == null || path.length > 20) return;
      if (typeof v === 'string') {
        let url = decodeMaybeEncodedUrl(v);
        if (!url) return;
        if (url.startsWith('//')) url = 'https:' + url;
        const kind = classify(url, path[path.length - 1] ?? '');
        if (kind) found({ url, kind, label: labelFromPath(path) });
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, [...path, i]));
      } else if (typeof v === 'object') {
        for (const k of Object.keys(v)) walk(v[k], [...path, k]);
      }
    };
    walk(root, []);
  }

  // Поиск ссылок в произвольном тексте (HTML плеера, конфиги Playerjs вида "[720p]https://...").
  function scanText(text, found) {
    const t = text.replace(/\\\//g, '/');
    const re = /(?:\[([^\]\s]{1,16})\])?((?:https?:)?\/\/[^\s"'<>\\,\]]+?\.(?:m3u8|mp4|mpd)(?:[?#][^\s"'<>\\,\]]*)?)(?=[\s"'<>\\,\]]|$)/gi;
    let m;
    let n = 0;
    while ((m = re.exec(t)) && n++ < 200) {
      let url = m[2];
      if (url.startsWith('//')) url = 'https:' + url;
      const kind = classify(url);
      if (kind) found({ url, kind, label: m[1] || '' });
    }
  }

  return { detect, isKnownPlayerRequest, classify, scanJson, scanText, decodeMaybeEncodedUrl };
})();
