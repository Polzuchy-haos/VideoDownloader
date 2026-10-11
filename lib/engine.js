'use strict';

// Загрузчик HLS: скачивает сегменты, расшифровывает, склеивает и отдаёт Blob на сохранение.
// Firefox: работает в фоновой странице. Chrome: в offscreen-документе (в service worker нет blob URL).
//
// hooks.allowHeaders(urls, stream) — подставить Referer/Origin плеера для запросов к этим хостам;
// hooks.save(blob, filename, saveAs) — сохранить файл через downloads API.
const Engine = (() => {
  async function fetchRetry(url, signal, opts = {}) {
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (signal.aborted) throw new Error('Отменено');
      try {
        const headers = {};
        if (opts.byterange) {
          const { offset, length } = opts.byterange;
          headers.Range = `bytes=${offset}-${offset + length - 1}`;
        }
        const r = await fetch(url, { signal, credentials: 'include', headers });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return opts.text ? await r.text() : await r.arrayBuffer();
      } catch (e) {
        if (signal.aborted) throw new Error('Отменено');
        lastErr = e;
        await U.sleep(700 * (attempt + 1));
      }
    }
    throw new Error(`Не удалось загрузить ${U.shortUrl(url)}: ${lastErr && lastErr.message}`);
  }

  function hexToBytes(hex) {
    hex = hex.replace(/^0x/i, '').padStart(32, '0');
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function ivFromSeq(seq) {
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, seq);
    return iv;
  }

  // Некоторые CDN маскируют TS-сегменты под картинки, добавляя мусор в начало.
  function fixTs(buf) {
    const u = new Uint8Array(buf);
    const ok = i => u[i] === 0x47 && (i + 188 >= u.length || u[i + 188] === 0x47) && (i + 376 >= u.length || u[i + 376] === 0x47);
    if (u.length < 188 || ok(0)) return buf;
    const lim = Math.min(u.length - 376, 1 << 20);
    for (let i = 1; i < lim; i++) if (ok(i)) return buf.slice(i);
    return buf;
  }

  // Один URL на хост — правил заголовков нужно по хосту, а не по сегменту.
  function onePerHost(urls) {
    const byHost = new Map();
    for (const u of urls) {
      const h = U.hostnameOf(u);
      if (h && !byHost.has(h)) byHost.set(h, u);
    }
    return [...byHost.values()];
  }

  function extFor(pl, type) {
    if (pl.hasMap) return type === 'audio' ? 'm4a' : 'mp4';
    const first = U.stripQuery(pl.segments[0].url);
    if (/\.aac$/i.test(first)) return 'aac';
    if (/\.mp3$/i.test(first)) return 'mp3';
    return 'ts';
  }

  class Engine {
    constructor(hooks) {
      this.hooks = hooks;
      this.jobs = new Map();
    }

    get active() {
      for (const j of this.jobs.values()) if (j.status === 'running' || j.status === 'saving') return true;
      return false;
    }

    // spec: { tabId, kind: 'hls' | 'direct', stream: { url, referer, origin }, variantUrl, audioUrl, name, concurrency, saveAs }
    start(spec) {
      const job = {
        id: U.uid(),
        tabId: spec.tabId,
        name: U.sanitizeFilename(spec.name),
        kind: spec.kind || 'hls',
        status: 'running',
        phase: '',
        done: 0,
        total: 0,
        bytes: 0,
        totalBytes: 0,
        started: Date.now(),
        error: null,
        files: [],
        abort: new AbortController(),
      };
      this.jobs.set(job.id, job);
      const run = job.kind === 'direct' ? this.runDirect(job, spec) : this.run(job, spec);
      run.catch(e => {
        job.status = job.abort.signal.aborted ? 'cancelled' : 'error';
        job.error = e && e.message || String(e);
      });
      return job.id;
    }

    cancel(id) {
      const j = this.jobs.get(id);
      if (!j) return false;
      j.abort.abort();
      if (j.status === 'running' || j.status === 'saving') j.status = 'cancelled';
      return true;
    }

    remove(id) {
      const j = this.jobs.get(id);
      if (!j) return false;
      j.abort.abort();
      this.jobs.delete(id);
      return true;
    }

    list() {
      return [...this.jobs.values()].map(j => ({
        id: j.id, tabId: j.tabId, name: j.name, kind: j.kind, status: j.status, phase: j.phase,
        done: j.done, total: j.total, bytes: j.bytes, totalBytes: j.totalBytes,
        started: j.started, error: j.error, files: j.files,
      }));
    }

    // Прямой файл через fetch (Chrome: правила declarativeNetRequest не действуют на chrome.downloads,
    // поэтому Referer/Origin можно подставить только так). Обрыв — докачка через Range.
    async runDirect(job, spec) {
      const { url } = spec.stream;
      const signal = job.abort.signal;
      await this.hooks.allowHeaders([url], spec.stream);
      const chunks = [];
      let type = '';
      let lastErr;
      for (let attempt = 0; attempt < 6; attempt++) {
        if (signal.aborted) throw new Error('Отменено');
        try {
          const headers = job.bytes ? { Range: `bytes=${job.bytes}-` } : {};
          const r = await fetch(url, { signal, credentials: 'include', headers });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          if (job.bytes && r.status !== 206) { // сервер не умеет Range — начинаем заново
            chunks.length = 0;
            job.bytes = 0;
          }
          type = (r.headers.get('content-type') || '').split(';')[0];
          if (!job.totalBytes) {
            const range = r.headers.get('content-range');
            job.totalBytes = +(range && range.split('/')[1]) || +r.headers.get('content-length') || 0;
          }
          const reader = r.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            job.bytes += value.byteLength;
          }
          if (job.totalBytes && job.bytes < job.totalBytes) throw new Error('соединение оборвалось');
          lastErr = null;
          break;
        } catch (e) {
          if (signal.aborted) throw new Error('Отменено');
          lastErr = e;
          await U.sleep(1000 * (attempt + 1));
        }
      }
      if (lastErr) throw new Error(`Не удалось загрузить ${U.shortUrl(url)}: ${lastErr.message}`);

      job.status = 'saving';
      const ext = (U.stripQuery(url).match(/\.(mp4|m4v|webm|mkv)$/i) || [, 'mp4'])[1];
      const filename = `${job.name}.${ext}`;
      await this.hooks.save(new Blob(chunks, { type: type || 'video/mp4' }), filename, !!spec.saveAs);
      job.files.push(filename);
      job.status = 'done';
    }

    async run(job, spec) {
      const tracks = [{ type: 'video', url: spec.variantUrl || spec.stream.url }];
      if (spec.audioUrl) tracks.push({ type: 'audio', url: spec.audioUrl });
      for (const tr of tracks) {
        job.phase = tracks.length > 1 ? (tr.type === 'video' ? 'видео' : 'аудио') : '';
        job.status = 'running';
        const pl = await this.loadMediaPlaylist(tr.url, spec.stream, job.abort.signal);
        const blob = await this.downloadSegments(pl, job, spec.concurrency || 6);
        job.status = 'saving';
        const suffix = tracks.length > 1 ? (tr.type === 'video' ? '.video' : '.audio') : '';
        const filename = `${job.name}${suffix}.${extFor(pl, tr.type)}`;
        await this.hooks.save(blob, filename, !!spec.saveAs);
        job.files.push(filename);
      }
      job.status = 'done';
    }

    async loadMediaPlaylist(url, stream, signal) {
      await this.hooks.allowHeaders([url], stream);
      const text = await fetchRetry(url, signal, { text: true });
      const pl = M3U8.parse(text, url);
      if (pl.type === 'master') {
        if (!pl.variants.length) throw new Error('В master-плейлисте нет вариантов');
        return this.loadMediaPlaylist(pl.variants[0].url, stream, signal);
      }
      if (!pl.segments.length) throw new Error('Плейлист пуст');
      const urls = [];
      for (const s of pl.segments) {
        urls.push(s.url);
        if (s.key && s.key.url) urls.push(s.key.url);
        if (s.map) urls.push(s.map.url);
      }
      await this.hooks.allowHeaders(onePerHost(urls), stream);
      return pl;
    }

    async downloadSegments(pl, job, concurrency) {
      const segs = pl.segments;
      const signal = job.abort.signal;
      const bad = segs.find(s => s.key && s.key.method !== 'AES-128');
      if (bad) throw new Error(`Шифрование ${bad.key.method} (DRM) не поддерживается`);

      job.done = 0;
      job.total = segs.length;
      const keyCache = new Map();
      const getKey = k => {
        if (!keyCache.has(k.url)) {
          keyCache.set(k.url, fetchRetry(k.url, signal).then(raw =>
            crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt'])));
        }
        return keyCache.get(k.url);
      };

      const results = new Array(segs.length);
      let next = 0;
      const worker = async () => {
        while (next < segs.length) {
          const i = next++;
          const s = segs[i];
          let data = await fetchRetry(s.url, signal, { byterange: s.byterange });
          if (s.key) {
            const iv = s.key.iv ? hexToBytes(s.key.iv) : ivFromSeq(s.seq);
            data = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, await getKey(s.key), data);
          }
          if (!s.map && !/\.(aac|mp3|m4a|m4s|mp4)$/i.test(U.stripQuery(s.url))) data = fixTs(data);
          results[i] = new Blob([data]);
          job.done++;
          job.bytes += data.byteLength;
        }
      };
      const n = Math.max(1, Math.min(concurrency, segs.length));
      await Promise.all(Array.from({ length: n }, worker));

      const parts = [];
      let lastMap = null;
      for (let i = 0; i < segs.length; i++) {
        const m = segs[i].map;
        if (m && m.url !== lastMap) {
          parts.push(await fetchRetry(m.url, signal, { byterange: m.byterange }));
          lastMap = m.url;
        }
        parts.push(results[i]);
      }
      return new Blob(parts, { type: pl.hasMap ? 'video/mp4' : 'video/mp2t' });
    }
  }

  Engine.fetchRetry = fetchRetry;
  return Engine;
})();
