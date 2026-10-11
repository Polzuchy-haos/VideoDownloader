'use strict';

// Минимальный парсер HLS-плейлистов (master + media).
const M3U8 = (() => {
  function parseAttrs(str) {
    const out = {};
    const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
    let m;
    while ((m = re.exec(str))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
    return out;
  }

  function parseByteRange(s, prevEnd) {
    const [len, off] = s.split('@');
    return { length: +len, offset: off !== undefined ? +off : prevEnd };
  }

  function parse(text, baseUrl) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length || !lines[0].startsWith('#EXTM3U')) {
      throw new Error('Ответ не является m3u8-плейлистом');
    }
    if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) return parseMaster(lines, baseUrl);
    return parseMedia(lines, baseUrl);
  }

  function parseMaster(lines, base) {
    const variants = [];
    const media = [];
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrs(l.slice(13));
        media.push({
          type: a.TYPE,
          groupId: a['GROUP-ID'],
          name: a.NAME || a.LANGUAGE || 'track',
          language: a.LANGUAGE || '',
          isDefault: a.DEFAULT === 'YES',
          url: a.URI ? U.absolutize(a.URI, base) : null,
        });
      } else if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttrs(l.slice(18));
        let uri = null;
        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j].startsWith('#')) { uri = lines[j]; i = j; break; }
        }
        if (!uri) continue;
        const url = U.absolutize(uri, base);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const res = a.RESOLUTION || '';
        variants.push({
          url,
          bandwidth: +a.BANDWIDTH || +a['AVERAGE-BANDWIDTH'] || 0,
          resolution: res,
          height: parseInt(res.split('x')[1], 10) || null,
          codecs: a.CODECS || '',
          audio: a.AUDIO || null,
          name: a.NAME || null,
        });
      }
    }
    variants.sort((x, y) => (y.height || 0) - (x.height || 0) || y.bandwidth - x.bandwidth);
    return { type: 'master', variants, media };
  }

  function parseMedia(lines, base) {
    const segments = [];
    let seq = 0, key = null, map = null, dur = 0, byterange = null, lastEnd = 0, total = 0, endList = false;
    for (const l of lines) {
      if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        seq = parseInt(l.slice(22), 10) || 0;
      } else if (l.startsWith('#EXT-X-KEY:')) {
        const a = parseAttrs(l.slice(11));
        key = a.METHOD && a.METHOD !== 'NONE'
          ? { method: a.METHOD, url: U.absolutize(a.URI, base), iv: a.IV || null }
          : null;
      } else if (l.startsWith('#EXT-X-MAP:')) {
        const a = parseAttrs(l.slice(11));
        map = {
          url: U.absolutize(a.URI, base),
          byterange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null,
        };
      } else if (l.startsWith('#EXTINF:')) {
        dur = parseFloat(l.slice(8)) || 0;
      } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
        byterange = l.slice(17);
      } else if (l.startsWith('#EXT-X-ENDLIST')) {
        endList = true;
      } else if (!l.startsWith('#')) {
        let br = null;
        if (byterange) {
          br = parseByteRange(byterange, lastEnd);
          lastEnd = br.offset + br.length;
          byterange = null;
        }
        segments.push({
          url: U.absolutize(l, base),
          duration: dur,
          seq: seq + segments.length,
          key,
          map,
          byterange: br,
        });
        total += dur;
        dur = 0;
      }
    }
    return {
      type: 'media',
      segments,
      duration: total,
      endList,
      encrypted: segments.some(s => s.key),
      hasMap: segments.some(s => s.map),
    };
  }

  return { parse, parseAttrs };
})();
