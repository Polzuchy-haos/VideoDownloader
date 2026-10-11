'use strict';

const U = {
  hostOf(url) {
    try { return new URL(url).host; } catch { return ''; }
  },

  hostnameOf(url) {
    try { return new URL(url).hostname; } catch { return ''; }
  },

  originOf(url) {
    try { return new URL(url).origin; } catch { return ''; }
  },

  stripQuery(url) {
    const i = url.search(/[?#]/);
    return i < 0 ? url : url.slice(0, i);
  },

  absolutize(url, base) {
    if (!url) return null;
    if (url.startsWith('//')) url = 'https:' + url;
    try { return new URL(url, base).href; } catch { return null; }
  },

  sanitizeFilename(name) {
    const s = String(name || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 150);
    return s || 'video';
  },

  caesar(s, shift) {
    return s.replace(/[a-zA-Z]/g, c => {
      const b = c <= 'Z' ? 65 : 97;
      return String.fromCharCode((c.charCodeAt(0) - b + shift) % 26 + b);
    });
  },

  b64decode(s) {
    try {
      s = s.replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      return atob(s);
    } catch {
      return null;
    }
  },

  headerValue(headers, name) {
    name = name.toLowerCase();
    const h = (headers || []).find(h => h.name.toLowerCase() === name);
    return h ? h.value : undefined;
  },

  uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  },

  sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  },

  shortUrl(url) {
    const p = U.stripQuery(url);
    return p.length > 80 ? p.slice(0, 40) + '…' + p.slice(-35) : p;
  },
};
