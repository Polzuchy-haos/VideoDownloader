'use strict';

// Chrome (MV3): service worker сам подгружает библиотеки. Firefox (MV2): они перечислены в manifest.json.
if (typeof importScripts === 'function' && typeof window === 'undefined') {
  importScripts('lib/compat.js', 'lib/util.js', 'lib/m3u8.js', 'lib/players.js', 'lib/engine.js');
}

const IS_SW = typeof window === 'undefined'; // Chrome service worker: засыпает, нет blob URL
const actionApi = browser.action || browser.browserAction;

// Сайты, на вкладках которых включается глубокий анализ ответов (чтение тел XHR/фреймов).
const SITES_RE = /(^|\.)(yummyani\.me|yummy-anime\.ru|yummyanime\.tv|yummy-anime\.com|yummyanime\.club)$/i;

const settings = { saveAs: false, deepSniffAll: false, concurrency: 6 };

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------

const tabs = new Map();        // tabId -> { url, streams: Map<key, stream> }
const frameTree = new Map();   // tabId -> Map<frameId, { parent, url }>
const directJobs = new Map();  // id -> загрузка прямого файла через downloads API
const frameTokens = new Map(); // token из picker -> frameId (Chrome: нет runtime.getFrameId)
const reqInfo = new Map();     // requestId -> { referer, origin }

function tabState(tabId) {
  let t = tabs.get(tabId);
  if (!t) {
    t = { url: '', streams: new Map() };
    tabs.set(tabId, t);
  }
  return t;
}

// В Chrome service worker выгружается через ~30 с простоя — храним найденное в storage.session.
const persistent = IS_SW && !!browser.storage.session;
let saveTimer = 0;

function scheduleSave() {
  if (!persistent) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = {};
    for (const [id, t] of tabs) {
      data[id] = { url: t.url, streams: [...t.streams.values()].map(({ probePromise, ...s }) => s) };
    }
    browser.storage.session.set({ tabs: data, directJobs: [...directJobs.values()] }).catch(() => {});
  }, 300);
}

const ready = (async () => {
  const r = await browser.storage.local.get('settings').catch(() => ({}));
  Object.assign(settings, r.settings || {});
  if (persistent) {
    const s = await browser.storage.session.get(['tabs', 'directJobs']).catch(() => ({}));
    for (const [id, t] of Object.entries(s.tabs || {})) {
      const ts = tabState(+id);
      if (!ts.url) ts.url = t.url;
      for (const st of t.streams) if (!ts.streams.has(st.key)) ts.streams.set(st.key, { ...st, probePromise: null });
    }
    for (const j of s.directJobs || []) if (!directJobs.has(j.id)) directJobs.set(j.id, j);
  }
  if (!IS_FIREFOX) await loadDnrRules().catch(() => {});
  for (const t of await browser.tabs.query({}).catch(() => [])) {
    const ts = tabState(t.id);
    ts.url = t.url || ts.url;
  }
})();

browser.tabs.onUpdated.addListener((id, info) => { if (info.url) tabState(id).url = info.url; });
browser.tabs.onRemoved.addListener(id => {
  tabs.delete(id);
  frameTree.delete(id);
  scheduleSave();
});

function updateBadge(tabId) {
  const n = tabs.get(tabId)?.streams.size || 0;
  actionApi.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  actionApi.setBadgeBackgroundColor({ tabId, color: '#e8475f' }).catch(() => {});
}

function findStream(tabId, streamId) {
  for (const s of tabs.get(tabId)?.streams.values() || []) if (s.id === streamId) return s;
  return null;
}

// ---------------------------------------------------------------------------
// Дерево фреймов (нужно Chrome: у него в webRequest нет documentUrl/frameAncestors)
// ---------------------------------------------------------------------------

function noteFrame(tabId, frameId, parent, url) {
  if (tabId < 0 || frameId == null) return;
  let tree = frameTree.get(tabId);
  if (!tree) frameTree.set(tabId, tree = new Map());
  const f = tree.get(frameId) || {};
  if (parent != null && parent >= -1) f.parent = parent;
  if (url) f.url = url;
  tree.set(frameId, f);
}

browser.webNavigation.onBeforeNavigate.addListener(d => {
  if (d.frameId === 0) {
    const ts = tabState(d.tabId);
    ts.url = d.url;
    ts.streams.clear();
    frameTree.delete(d.tabId);
    updateBadge(d.tabId);
    scheduleSave();
  }
  noteFrame(d.tabId, d.frameId, d.parentFrameId, d.url);
});
browser.webNavigation.onCommitted.addListener(d => noteFrame(d.tabId, d.frameId, d.parentFrameId, d.url));

// Достраивает documentUrl и цепочку предков фрейма там, где браузер их не даёт.
function enrich(d) {
  if (d.frameAncestors && d.documentUrl) return d;
  const tree = frameTree.get(d.tabId);
  const out = { ...d };
  if (!out.documentUrl) {
    out.documentUrl = d.frameId === 0
      ? tabState(d.tabId).url
      : tree?.get(d.frameId)?.url || (d.initiator ? d.initiator + '/' : undefined);
  }
  if (!out.frameAncestors) {
    const chain = [];
    let cur = d.frameId;
    for (let guard = 0; cur > 0 && guard < 20; guard++) {
      let p = tree?.get(cur)?.parent;
      if (p == null && cur === d.frameId) p = d.parentFrameId;
      if (p == null || p < 0) { out.ancestorsIncomplete = true; break; }
      chain.push({ frameId: p, url: p === 0 ? tabState(d.tabId).url : tree?.get(p)?.url });
      cur = p;
    }
    out.frameAncestors = chain;
  }
  return out;
}

// frameId iframe верхнего уровня, внутри которого сделан запрос (0 — сама страница, null — пока неизвестно).
function rootFrameOf(d) {
  if (!d.frameId) return 0;
  if (d.ancestorsIncomplete) return null;
  const anc = d.frameAncestors || [];
  if (anc.length >= 2) return anc[anc.length - 2].frameId;
  return d.frameId;
}

async function resolveRoots(tabId, list) {
  if (!list.some(s => s.rootFrameId == null)) return;
  const frames = await browser.webNavigation.getAllFrames({ tabId }).catch(() => null) || [];
  const parent = new Map(frames.map(f => [f.frameId, f.parentFrameId]));
  for (const s of list) {
    if (s.rootFrameId != null) continue;
    let cur = s.frameId;
    for (let guard = 0; guard < 20; guard++) {
      const p = parent.get(cur);
      if (p == null) break;
      if (p === 0) { s.rootFrameId = cur; break; }
      if (p < 0) { s.rootFrameId = 0; break; }
      cur = p;
    }
  }
}

// ---------------------------------------------------------------------------
// Регистрация найденных потоков
// ---------------------------------------------------------------------------

function registerStream(d, { url, kind, label = '', size = 0 }) {
  if (d.tabId < 0 || !url) return;
  url = U.absolutize(url, d.url);
  if (!url || !/^https?:/i.test(url)) return;
  d = enrich(d);

  const ts = tabState(d.tabId);
  const key = kind + '|' + U.stripQuery(url);
  const existing = ts.streams.get(key);
  if (existing) {
    existing.url = url; // свежий токен
    existing.time = Date.now();
    if (label && !existing.label) existing.label = label;
    scheduleSave();
    return;
  }

  const info = (d.requestId && reqInfo.get(d.requestId)) || {};
  const frameUrl = d.documentUrl || d.originUrl || ts.url;
  const stream = {
    id: U.uid(),
    key,
    url,
    kind, // hls | direct | dash
    label,
    size,
    player: Players.detect(d),
    frameUrl,
    frameId: d.frameId,
    rootFrameId: rootFrameOf(d),
    frameUrls: [d.documentUrl, ...(d.frameAncestors || []).map(f => f.url)].filter(Boolean),
    referer: info.referer || frameUrl || ts.url,
    origin: info.origin || (frameUrl && U.originOf(frameUrl)) || '',
    time: Date.now(),
    probe: null,
    probePromise: null,
  };
  ts.streams.set(key, stream);
  if (kind === 'hls') probe(d.tabId, stream.id);

  // Kodik: из ".../720.mp4:hls:manifest.m3u8" можно получить прямой файл ".../720.mp4".
  if (kind === 'hls' && /\.mp4:hls:manifest\.m3u8/i.test(url)) {
    const mp4 = url.replace(/:hls:manifest\.m3u8.*$/i, '');
    const q = (mp4.match(/\/(\d{3,4})\.mp4$/) || [])[1];
    registerStream(d, { url: mp4, kind: 'direct', label: (q ? q + 'p ' : '') + 'прямой MP4' });
  }
  updateBadge(d.tabId);
  scheduleSave();
}

const SEGMENT_RE = /\.(ts|m4s|m4a|aac|vtt|webvtt|key|jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf)$/i;

function isSegmentLike(url) {
  return SEGMENT_RE.test(U.stripQuery(url));
}

const SNIFF_LIMIT = 1536 * 1024;

function analyzeText(d, text, truncated = false) {
  const head = text.slice(0, 64).trimStart();
  if (head.startsWith('#EXTM3U')) {
    registerStream(d, { url: d.url, kind: 'hls' });
    return;
  }
  if (truncated) return;
  const found = f => registerStream(d, f);
  if (head.startsWith('{') || head.startsWith('[')) {
    try { Players.scanJson(JSON.parse(text), found); } catch {}
  }
  Players.scanText(text, found);
}

// ---------------------------------------------------------------------------
// Перехват запросов (оба браузера, без блокировки)
// ---------------------------------------------------------------------------

browser.webRequest.onSendHeaders.addListener(d => {
  if (d.tabId < 0) return;
  reqInfo.set(d.requestId, {
    referer: U.headerValue(d.requestHeaders, 'referer'),
    origin: U.headerValue(d.requestHeaders, 'origin'),
  });
  if (reqInfo.size > 4000) {
    const it = reqInfo.keys();
    for (let i = 0; i < 1000; i++) reqInfo.delete(it.next().value);
  }
  if (d.type === 'main_frame' || isSegmentLike(d.url)) return;
  const kind = Players.classify(d.url);
  if (kind) registerStream(d, { url: d.url, kind });
}, { urls: ['<all_urls>'] }, IS_FIREFOX ? ['requestHeaders'] : ['requestHeaders', 'extraHeaders']);

const HLS_CT = /mpegurl/i;
const DASH_CT = /dash\+xml/i;
const VIDEO_CT = /^(video\/(mp4|webm|x-matroska|quicktime)|application\/mp4)$/i;

browser.webRequest.onHeadersReceived.addListener(d => {
  if (d.tabId < 0 || d.type === 'main_frame' || d.statusCode >= 400) return;
  if (isSegmentLike(d.url)) return;
  const ct = (U.headerValue(d.responseHeaders, 'content-type') || '').split(';')[0].trim();
  if (!ct) return;
  if (HLS_CT.test(ct)) {
    registerStream(d, { url: d.url, kind: 'hls' });
  } else if (DASH_CT.test(ct)) {
    registerStream(d, { url: d.url, kind: 'dash' });
  } else if (VIDEO_CT.test(ct)) {
    const range = U.headerValue(d.responseHeaders, 'content-range') || '';
    const total = +(range.split('/')[1] || 0) || +(U.headerValue(d.responseHeaders, 'content-length') || 0);
    if (total >= 3 * 1024 * 1024 && !/seg|chunk|frag/i.test(U.stripQuery(d.url).split('/').pop())) {
      registerStream(d, { url: d.url, kind: 'direct', size: total });
    }
  }
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

browser.webRequest.onBeforeRequest.addListener(d => {
  if (d.tabId >= 0) noteFrame(d.tabId, d.frameId, d.parentFrameId, d.url);
}, { urls: ['<all_urls>'], types: ['sub_frame'] });

const forget = d => setTimeout(() => reqInfo.delete(d.requestId), 15000);
browser.webRequest.onCompleted.addListener(forget, { urls: ['<all_urls>'] });
browser.webRequest.onErrorOccurred.addListener(forget, { urls: ['<all_urls>'] });

// ---------------------------------------------------------------------------
// Firefox: глубокий анализ тел ответов через filterResponseData.
// В Chrome то же делает content/hook.js (перехват fetch/XHR в странице плеера).
// ---------------------------------------------------------------------------

if (IS_FIREFOX) {
  const shouldDeepSniff = d => {
    if (isSegmentLike(d.url) || Players.classify(d.url)) return false;
    if (settings.deepSniffAll) return true;
    return SITES_RE.test(U.hostOf(tabState(d.tabId).url)) || Players.isKnownPlayerRequest(d);
  };

  browser.webRequest.onBeforeRequest.addListener(d => {
    if (d.tabId < 0 || !shouldDeepSniff(d)) return;
    let filter;
    try {
      filter = browser.webRequest.filterResponseData(d.requestId);
    } catch {
      return;
    }
    const chunks = [];
    let size = 0;
    let truncated = false;
    filter.ondata = e => {
      filter.write(e.data);
      if (truncated) return;
      size += e.data.byteLength;
      if (size > SNIFF_LIMIT) truncated = true;
      else chunks.push(e.data);
    };
    filter.onstop = () => {
      try { filter.close(); } catch {}
      if (!chunks.length) return;
      try {
        analyzeText(d, new TextDecoder('utf-8').decode(concat(chunks)), truncated);
      } catch (e) {
        console.debug('analyzeText', e);
      }
    };
    filter.onerror = () => {};
  }, { urls: ['<all_urls>'], types: ['sub_frame', 'xmlhttprequest'] }, ['blocking']);
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(new Uint8Array(c), off);
    off += c.byteLength;
  }
  return out;
}

// Chrome: ответы, перехваченные content/hook.js.
function analyzeSniffed(sender, msg) {
  const d = enrich({
    tabId: sender.tab.id,
    frameId: sender.frameId || 0,
    url: msg.url,
    documentUrl: sender.url,
    requestId: null,
  });
  analyzeText(d, msg.text.slice(0, SNIFF_LIMIT));
}

// ---------------------------------------------------------------------------
// Подмена Referer/Origin для запросов самого расширения
// Firefox — блокирующий onBeforeSendHeaders, Chrome — сессионные правила declarativeNetRequest.
// ---------------------------------------------------------------------------

const hostRules = new Map(); // Firefox: hostname -> { referer, origin }
const dnrIds = new Map();    // Chrome: hostname -> id правила
let dnrNext = 1;

async function loadDnrRules() {
  for (const r of await browser.declarativeNetRequest.getSessionRules()) {
    const host = r.condition.requestDomains && r.condition.requestDomains[0];
    if (host) dnrIds.set(host, r.id);
    dnrNext = Math.max(dnrNext, r.id + 1);
  }
}

async function allowHeaders(urls, stream) {
  const hosts = [...new Set(urls.map(U.hostnameOf).filter(Boolean))];
  if (!hosts.length) return;
  if (IS_FIREFOX) {
    for (const h of hosts) hostRules.set(h, { referer: stream.referer, origin: stream.origin });
    return;
  }
  const requestHeaders = [];
  if (stream.referer) requestHeaders.push({ header: 'referer', operation: 'set', value: stream.referer });
  requestHeaders.push(stream.origin
    ? { header: 'origin', operation: 'set', value: stream.origin }
    : { header: 'origin', operation: 'remove' });
  const removeRuleIds = [];
  const addRules = [];
  for (const h of hosts) {
    if (dnrIds.has(h)) removeRuleIds.push(dnrIds.get(h));
    const id = dnrNext++;
    dnrIds.set(h, id);
    addRules.push({
      id,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders },
      condition: { requestDomains: [h], tabIds: [-1] },
    });
  }
  await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
}

if (IS_FIREFOX) {
  browser.webRequest.onBeforeSendHeaders.addListener(d => {
    if (d.tabId !== -1) return;
    const rule = hostRules.get(U.hostnameOf(d.url));
    if (!rule) return;
    const headers = d.requestHeaders.filter(h => !/^(referer|origin)$/i.test(h.name));
    if (rule.referer) headers.push({ name: 'Referer', value: rule.referer });
    if (rule.origin) headers.push({ name: 'Origin', value: rule.origin });
    return { requestHeaders: headers };
  }, { urls: ['<all_urls>'] }, ['blocking', 'requestHeaders']);
}

// ---------------------------------------------------------------------------
// Загрузки HLS: локальный движок (Firefox) или offscreen-документ (Chrome)
// ---------------------------------------------------------------------------

const blobDownloads = new Map();      // Firefox: downloadId -> blob URL
const offscreenDownloads = new Set(); // Chrome: downloadId, чей blob URL живёт в offscreen

const localEngine = IS_SW ? null : new Engine({
  allowHeaders,
  save: async (blob, filename, saveAs) => {
    const url = URL.createObjectURL(blob);
    try {
      const id = await browser.downloads.download({ url, filename, saveAs, conflictAction: 'uniquify' });
      blobDownloads.set(id, url);
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  },
});

const OFFSCREEN_URL = 'offscreen/offscreen.html';
let offscreenCreating = null;

async function hasOffscreen() {
  if (!browser.offscreen) return false;
  if (browser.runtime.getContexts) {
    const ctx = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctx.length > 0;
  }
  return browser.offscreen.hasDocument ? browser.offscreen.hasDocument() : false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!offscreenCreating) {
    offscreenCreating = browser.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Сборка HLS-видео из сегментов и сохранение готового файла',
    }).finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

const toOffscreen = msg => browser.runtime.sendMessage({ ...msg, target: 'offscreen' });

const engine = {
  async start(spec) {
    if (localEngine) return { ok: true, jobId: localEngine.start(spec) };
    await ensureOffscreen();
    return toOffscreen({ type: 'start', spec });
  },
  async list() {
    if (localEngine) return localEngine.list();
    if (!(await hasOffscreen())) return [];
    return toOffscreen({ type: 'list' }).catch(() => []);
  },
  async cancel(id) {
    if (localEngine) return localEngine.cancel(id);
    if (await hasOffscreen()) await toOffscreen({ type: 'cancel', jobId: id }).catch(() => {});
  },
  async remove(id) {
    if (localEngine) return localEngine.remove(id);
    if (await hasOffscreen()) await toOffscreen({ type: 'remove', jobId: id }).catch(() => {});
  },
};

browser.downloads.onChanged.addListener(delta => {
  if (!delta.state || delta.state.current === 'in_progress') return;
  const url = blobDownloads.get(delta.id);
  if (url) {
    blobDownloads.delete(delta.id);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  if (offscreenDownloads.delete(delta.id)) {
    toOffscreen({ type: 'downloadDone', id: delta.id }).catch(() => {});
  }
});

async function saveBlobForOffscreen(msg) {
  const id = await browser.downloads.download({
    url: msg.url,
    filename: msg.filename,
    saveAs: !!msg.saveAs,
    conflictAction: 'uniquify',
  });
  offscreenDownloads.add(id);
  return { id };
}

// ---------------------------------------------------------------------------
// Запуск загрузки
// ---------------------------------------------------------------------------

async function startDownload(msg, tabId) {
  await ready;
  const stream = findStream(tabId, msg.streamId);
  if (!stream) return { error: 'Поток не найден — обновите список' };
  if (stream.kind === 'dash') return { error: 'DASH (.mpd) пока не поддерживается' };
  // Firefox: прямой файл качает штатный загрузчик (Referer подставляет onBeforeSendHeaders).
  // Chrome: declarativeNetRequest не трогает chrome.downloads — качаем через fetch в offscreen.
  if (stream.kind === 'direct' && IS_FIREFOX) return startDirect(stream, msg, tabId);
  return engine.start({
    tabId,
    kind: stream.kind,
    stream: { url: stream.url, referer: stream.referer, origin: stream.origin },
    variantUrl: msg.variantUrl || null,
    audioUrl: msg.audioUrl || null,
    name: msg.filename,
    concurrency: settings.concurrency,
    saveAs: settings.saveAs,
  });
}

async function startDirect(stream, msg, tabId) {
  const job = {
    id: U.uid(),
    tabId,
    name: U.sanitizeFilename(msg.filename),
    kind: 'direct',
    status: 'browser',
    started: Date.now(),
    files: [],
    error: null,
    downloadId: null,
  };
  directJobs.set(job.id, job);
  try {
    await allowHeaders([stream.url], stream);
    const ext = (U.stripQuery(stream.url).match(/\.(mp4|m4v|webm|mkv)$/i) || [, 'mp4'])[1];
    job.downloadId = await browser.downloads.download({
      url: stream.url,
      filename: `${job.name}.${ext}`,
      saveAs: settings.saveAs,
      conflictAction: 'uniquify',
    });
  } catch (e) {
    job.status = 'error';
    job.error = e && e.message || String(e);
  }
  scheduleSave();
  return { ok: true, jobId: job.id };
}

async function serializeDirect(j) {
  const out = {
    id: j.id, tabId: j.tabId, name: j.name, kind: j.kind, status: j.status, phase: '',
    done: 0, total: 0, bytes: 0, started: j.started, error: j.error, files: j.files,
  };
  if (j.downloadId != null && j.status === 'browser') {
    const [item] = await browser.downloads.search({ id: j.downloadId }).catch(() => []);
    if (item) {
      out.bytes = item.bytesReceived;
      out.totalBytes = item.totalBytes;
      if (item.state === 'complete') out.status = 'done';
      else if (item.state === 'interrupted') {
        out.status = 'error';
        out.error = 'Загрузка прервана: ' + (item.error || 'неизвестная ошибка');
      }
    }
  }
  return out;
}

async function listJobs(tabId) {
  const direct = await Promise.all([...directJobs.values()].map(serializeDirect));
  const hls = await engine.list();
  return [...direct, ...(Array.isArray(hls) ? hls : [])]
    .filter(j => tabId == null || j.tabId === tabId)
    .sort((a, b) => b.started - a.started);
}

async function cancelJob(id) {
  const j = directJobs.get(id);
  if (j) {
    if (j.downloadId != null) await browser.downloads.cancel(j.downloadId).catch(() => {});
    j.status = 'cancelled';
    scheduleSave();
  } else {
    await engine.cancel(id);
  }
  return { ok: true };
}

async function removeJob(id) {
  if (directJobs.delete(id)) scheduleSave();
  else await engine.remove(id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Анализ HLS-плейлиста (список качеств и аудиодорожек)
// ---------------------------------------------------------------------------

function probe(tabId, streamId) {
  const stream = findStream(tabId, streamId);
  if (!stream) return Promise.resolve({ error: 'Поток не найден' });
  if (stream.probe) return Promise.resolve(stream.probe);
  if (!stream.probePromise) stream.probePromise = doProbe(stream);
  return stream.probePromise;
}

async function doProbe(stream) {
  try {
    await allowHeaders([stream.url], stream);
    const text = await Engine.fetchRetry(stream.url, new AbortController().signal, { text: true });
    const pl = M3U8.parse(text, stream.url);
    if (pl.type === 'master') {
      stream.probe = {
        type: 'master',
        variants: pl.variants.map(v => ({
          url: v.url,
          audio: v.audio,
          height: v.height,
          label: [v.height ? v.height + 'p' : v.resolution || v.name, v.bandwidth ? Math.round(v.bandwidth / 1000) + ' кбит/с' : '']
            .filter(Boolean).join(' · ') || 'вариант',
        })),
        audios: pl.media.filter(m => m.type === 'AUDIO' && m.url),
      };
    } else {
      stream.probe = {
        type: 'media',
        duration: Math.round(pl.duration),
        segments: pl.segments.length,
        encrypted: pl.encrypted,
      };
    }
  } catch (e) {
    stream.probe = { type: 'error', error: e.message };
  }
  stream.probePromise = null;
  scheduleSave();
  return stream.probe;
}

// ---------------------------------------------------------------------------
// Ранжирование: какой поток «главный» для плеера
// ---------------------------------------------------------------------------

function qualityOf(s) {
  const m = (s.label || '').match(/(\d{3,4})p/) || U.stripQuery(s.url).match(/[/_-](\d{3,4})p?(?:\.mp4)?(?=[/:._-]|$)/);
  return m ? +m[1] : 0;
}

// child — вариант качества, который уже есть внутри найденного master-плейлиста.
function decorate(list) {
  const variantUrls = new Set();
  for (const s of list) {
    if (s.probe && s.probe.type === 'master') {
      for (const v of s.probe.variants) variantUrls.add(U.stripQuery(v.url));
      for (const a of s.probe.audios) variantUrls.add(U.stripQuery(a.url));
    }
  }
  return list.map(s => {
    const child = s.kind === 'hls' && (!s.probe || s.probe.type !== 'master') && variantUrls.has(U.stripQuery(s.url));
    const q = qualityOf(s) / 10000;
    let score;
    if (child) score = -1;
    else if (s.probe && s.probe.type === 'error') score = 0;
    else if (s.kind === 'direct' && /прямой/.test(s.label)) score = 4 + q;
    else if (s.kind === 'hls' && s.probe && s.probe.type === 'master') score = 3 + q;
    else if (s.kind === 'hls') score = 2 + q;
    else if (s.kind === 'direct') score = 1 + q;
    else score = 0.5;
    return { s, child, score };
  });
}

// Последняя «пачка» запросов плеера (то, что сейчас играет) — выше всех, внутри неё по score.
function rank(list) {
  const items = decorate(list);
  const latest = Math.max(0, ...items.filter(i => !i.child).map(i => i.s.time));
  for (const i of items) i.recent = i.s.time >= latest - 8000;
  items.sort((a, b) => (b.recent - a.recent) || (b.score - a.score) || (b.s.time - a.s.time));
  return items.map((i, idx) => ({
    id: i.s.id, url: i.s.url, kind: i.s.kind, label: i.s.label, size: i.s.size,
    player: i.s.player, frameUrl: i.s.frameUrl, time: i.s.time, probe: i.s.probe,
    child: i.child, best: idx === 0 && !i.child && i.score > 0,
  }));
}

// ---------------------------------------------------------------------------
// Состояние для popup и панели выбора плеера
// ---------------------------------------------------------------------------

async function getState(tabId) {
  await ready;
  const streams = rank([...(tabs.get(tabId)?.streams.values() || [])]);
  return { streams, jobs: await listJobs(null), settings };
}

// Если frameId элемента неизвестен — ищем фрейм по адресу iframe.
async function resolveFrameId(tabId, src) {
  if (!src) return null;
  const frames = await browser.webNavigation.getAllFrames({ tabId }).catch(() => null) || [];
  const want = U.stripQuery(src);
  const f = frames.find(f => f.parentFrameId === 0 && f.url === src)
    || frames.find(f => f.parentFrameId === 0 && U.stripQuery(f.url) === want);
  return f ? f.frameId : null;
}

async function getFrameState(tabId, msg) {
  await ready;
  let frameId = msg.frameId;
  if ((frameId == null || frameId < 0) && msg.token && frameTokens.has(msg.token)) frameId = frameTokens.get(msg.token);
  if (frameId == null || frameId < 0) frameId = await resolveFrameId(tabId, msg.src);

  const all = [...(tabs.get(tabId)?.streams.values() || [])];
  await resolveRoots(tabId, all);
  let list;
  if (frameId != null && frameId >= 0) {
    list = all.filter(s => s.rootFrameId === frameId);
  } else {
    const want = msg.src && U.stripQuery(msg.src);
    list = want ? all.filter(s => s.frameUrls.some(u => U.stripQuery(u) === want)) : [];
  }
  const player = list[0]?.player || (msg.src ? Players.detect({ url: msg.src }) : { id: 'other', name: 'Видео на странице' });
  return { frameId, player, streams: rank(list), jobs: await listJobs(tabId) };
}

async function startPicker(tabId) {
  try {
    if (IS_FIREFOX) await browser.tabs.executeScript(tabId, { file: '/content/picker.js', frameId: 0 });
    else await browser.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content/picker.js'] });
    return { ok: true };
  } catch (e) {
    return { error: 'Не удалось запустить выбор на этой странице: ' + (e && e.message || e) };
  }
}

browser.commands.onCommand.addListener(async cmd => {
  if (cmd !== 'pick-player') return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) startPicker(tab.id);
});

// ---------------------------------------------------------------------------
// Сообщения
// ---------------------------------------------------------------------------

const EXT_URL = browser.runtime.getURL('');
const fromExtensionPage = sender => !sender.tab && (sender.url || '').startsWith(EXT_URL);

onMessage((msg, sender) => {
  if (!msg || msg.target === 'offscreen') return undefined;
  const tabId = msg.tabId ?? sender.tab?.id;
  switch (msg.type) {
    case 'getState':
      return getState(tabId);
    case 'getFrameState':
      return getFrameState(tabId, msg);
    case 'startPicker':
      return startPicker(tabId);
    case 'probe':
      return ready.then(() => probe(tabId, msg.streamId));
    case 'download':
      return startDownload(msg, tabId);
    case 'cancel':
      return cancelJob(msg.jobId);
    case 'removeJob':
      return removeJob(msg.jobId);
    case 'clearStreams':
      return ready.then(() => {
        tabs.get(tabId)?.streams.clear();
        updateBadge(tabId);
        scheduleSave();
        return { ok: true };
      });
    case 'setSettings':
      Object.assign(settings, msg.settings);
      return browser.storage.local.set({ settings }).then(() => ({ ok: true }));

    // От content-скриптов во фреймах
    case 'frameHello':
      if (sender.tab && msg.token) {
        frameTokens.set(String(msg.token), sender.frameId || 0);
        if (frameTokens.size > 200) frameTokens.delete(frameTokens.keys().next().value);
      }
      return { ok: true };
    case 'sniffed':
      if (sender.tab && typeof msg.text === 'string' && typeof msg.url === 'string') {
        ready.then(() => analyzeSniffed(sender, msg));
      }
      return { ok: true };

    // От offscreen-документа (Chrome)
    case 'allowHeaders':
      if (!fromExtensionPage(sender)) return { error: 'forbidden' };
      return allowHeaders(msg.urls || [], msg.stream || {}).then(() => ({ ok: true }));
    case 'saveBlob':
      if (!fromExtensionPage(sender)) return { error: 'forbidden' };
      return saveBlobForOffscreen(msg);
    case 'keepalive':
      return { ok: true };
  }
  return undefined;
});
