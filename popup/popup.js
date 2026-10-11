'use strict';

const $ = s => document.querySelector(s);

let tab = null;
let streamsSig = '';
let settingsLoaded = false;
const ui = {}; // streamId -> { name, variant, audio }
const probing = new Set();

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

const send = msg => browser.runtime.sendMessage(msg);

function fmtBytes(n) {
  if (!n) return '0 Б';
  const u = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i > 1 ? 1 : 0) + ' ' + u[i];
}

function fmtDuration(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function cleanTitle(title) {
  let t = (title || '').split(' | ')[0];
  t = t.replace(/\s*[—–-]\s*(смотреть|аниме|онлайн).*$/i, '').replace(/^смотреть\s+/i, '').trim();
  return t || 'video';
}

function defaultName(s) {
  const q = s.label && /^\d{3,4}p/.test(s.label) ? ' ' + s.label.split(' ')[0] : '';
  return `${cleanTitle(tab.title)} [${s.player.name}]${q}`;
}

// ---------------------------------------------------------------------------

async function init() {
  [tab] = await browser.tabs.query({ active: true, currentWindow: true });

  $('#pick').addEventListener('click', async () => {
    const res = await send({ type: 'startPicker', tabId: tab.id });
    if (res && res.error) {
      $('#pickError').textContent = res.error;
      $('#pickError').hidden = false;
    } else {
      window.close();
    }
  });
  $('#showChildren').addEventListener('change', () => { streamsSig = ''; refresh(); });

  $('#clear').addEventListener('click', async () => {
    await send({ type: 'clearStreams', tabId: tab.id });
    refresh();
  });
  for (const id of ['saveAs', 'deepSniffAll']) {
    $('#' + id).addEventListener('change', e => send({ type: 'setSettings', settings: { [id]: e.target.checked } }));
  }
  $('#concurrency').addEventListener('change', e =>
    send({ type: 'setSettings', settings: { concurrency: +e.target.value } }));

  await refresh();
  setInterval(refresh, 800);
}

async function refresh() {
  const state = await send({ type: 'getState', tabId: tab.id });
  if (!settingsLoaded) {
    settingsLoaded = true;
    $('#saveAs').checked = !!state.settings.saveAs;
    $('#deepSniffAll').checked = !!state.settings.deepSniffAll;
    $('#concurrency').value = String(state.settings.concurrency);
  }
  const sig = $('#showChildren').checked + '|' +
    state.streams.map(s => s.id + (s.probe ? ':' + s.probe.type : '') + (s.best ? '*' : '')).join(',');
  if (sig !== streamsSig) {
    streamsSig = sig;
    renderStreams(state.streams);
  }
  renderJobs(state.jobs);
}

// ---------------------------------------------------------------------------

function renderStreams(streams) {
  const box = $('#streams');
  box.replaceChildren();
  $('#empty').hidden = streams.length > 0;
  const children = streams.filter(s => s.child).length;
  $('#showChildrenRow').hidden = children === 0;
  $('#childCount').textContent = children;
  const showChildren = $('#showChildren').checked;
  for (const s of streams) {
    if (s.child && !showChildren) continue;
    box.append(renderStream(s));
    if (s.kind === 'hls' && !s.probe && !probing.has(s.id)) {
      probing.add(s.id);
      send({ type: 'probe', tabId: tab.id, streamId: s.id }).finally(() => probing.delete(s.id));
    }
  }
}

function renderStream(s) {
  const st = ui[s.id] || (ui[s.id] = { name: defaultName(s), variant: null, audio: '' });
  const kindLabel = { hls: 'HLS', direct: 'MP4', dash: 'DASH' }[s.kind];

  const head = el('div', {},
    s.best ? el('span', { class: 'badge best' }, 'Рекомендуется') : null,
    el('span', { class: 'badge ' + s.player.id }, s.player.name),
    el('span', { class: 'badge' }, kindLabel),
    s.label ? el('span', {}, s.label + ' ') : null,
    s.size ? el('span', { class: 'hint' }, fmtBytes(s.size)) : null,
  );
  const url = el('div', { class: 'url', title: s.url }, s.url);
  const card = el('div', { class: 'card' + (s.best ? ' best' : '') }, head, url);

  if (s.kind === 'hls') card.append(renderHlsOptions(s, st));
  if (s.kind === 'dash') {
    card.append(el('div', { class: 'row hint' }, 'DASH-потоки не поддерживаются, можно только скопировать ссылку.'));
  }

  const nameInput = el('input', { type: 'text', value: st.name, title: 'Имя файла (без расширения)' });
  nameInput.addEventListener('input', () => { st.name = nameInput.value; });

  const status = el('div', { class: 'job-meta' });
  const dlBtn = el('button', {
    class: 'primary',
    disabled: s.kind === 'dash',
    onclick: async () => {
      dlBtn.disabled = true;
      const res = await send({
        type: 'download',
        tabId: tab.id,
        streamId: s.id,
        filename: st.name,
        variantUrl: st.variant,
        audioUrl: st.audio || null,
      });
      dlBtn.disabled = false;
      status.className = res.error ? 'job-meta error' : 'job-meta ok';
      status.textContent = res.error || 'Загрузка запущена';
      refresh();
    },
  }, 'Скачать');
  const copyBtn = el('button', {
    title: 'Копировать ссылку',
    onclick: async () => {
      await navigator.clipboard.writeText(st.variant || s.url);
      status.className = 'job-meta ok';
      status.textContent = 'Ссылка скопирована';
    },
  }, 'Ссылка');

  card.append(el('div', { class: 'row' }, nameInput, dlBtn, copyBtn), status);
  return card;
}

function renderHlsOptions(s, st) {
  const p = s.probe;
  if (!p) return el('div', { class: 'row hint' }, 'Анализ плейлиста…');
  if (p.type === 'error') return el('div', { class: 'row error' }, 'Ошибка анализа: ' + p.error);
  if (p.type === 'media') {
    const info = [`${fmtDuration(p.duration)}`, `${p.segments} сегм.`, p.encrypted ? 'AES-128' : null];
    return el('div', { class: 'row hint' }, info.filter(Boolean).join(' · '));
  }

  if (!st.variant || !p.variants.some(v => v.url === st.variant)) st.variant = p.variants[0]?.url || null;
  const frag = el('div');

  const qSel = el('select', { title: 'Качество' },
    p.variants.map(v => el('option', { value: v.url, selected: v.url === st.variant }, v.label)));
  frag.append(el('div', { class: 'row' }, el('span', { class: 'hint' }, 'Качество:'), qSel));

  const audioRow = el('div', { class: 'row' });
  frag.append(audioRow);

  const renderAudio = () => {
    audioRow.replaceChildren();
    const v = p.variants.find(x => x.url === st.variant);
    const tracks = p.audios.filter(a => !v || !v.audio || a.groupId === v.audio);
    if (!tracks.length) { st.audio = ''; return; }
    if (!tracks.some(a => a.url === st.audio)) st.audio = (tracks.find(a => a.isDefault) || tracks[0]).url;
    const aSel = el('select', { title: 'Аудиодорожка (сохраняется отдельным файлом)' },
      el('option', { value: '' }, 'Без отдельной аудиодорожки'),
      tracks.map(a => el('option', { value: a.url, selected: a.url === st.audio },
        a.name + (a.language ? ` (${a.language})` : ''))));
    aSel.addEventListener('change', () => { st.audio = aSel.value; });
    audioRow.append(el('span', { class: 'hint' }, 'Озвучка:'), aSel);
  };
  qSel.addEventListener('change', () => { st.variant = qSel.value; renderAudio(); });
  renderAudio();
  return frag;
}

// ---------------------------------------------------------------------------

const STATUS_TEXT = {
  running: 'Загрузка',
  saving: 'Сохранение',
  browser: 'Загружается браузером',
  done: 'Готово',
  error: 'Ошибка',
  cancelled: 'Отменено',
};

function renderJobs(jobs) {
  $('#jobsSection').hidden = jobs.length === 0;
  const box = $('#jobs');
  box.replaceChildren(...jobs.map(renderJob));
}

function renderJob(j) {
  const active = ['running', 'saving', 'browser'].includes(j.status);
  let pct = 0;
  if (j.total) pct = (j.done / j.total) * 100;
  else if (j.totalBytes > 0) pct = (j.bytes / j.totalBytes) * 100;
  if (j.status === 'done') pct = 100;

  const secs = Math.max(1, (Date.now() - j.started) / 1000);
  const meta = [];
  meta.push(STATUS_TEXT[j.status] + (j.phase ? ` (${j.phase})` : ''));
  if (j.total) meta.push(`${j.done}/${j.total} сегм.`);
  if (j.bytes) meta.push(fmtBytes(j.bytes) + (j.totalBytes > 0 ? ' из ' + fmtBytes(j.totalBytes) : ''));
  if (j.status === 'running' && j.bytes) meta.push(fmtBytes(j.bytes / secs) + '/с');

  const btn = active
    ? el('button', { class: 'ghost', onclick: () => send({ type: 'cancel', jobId: j.id }).then(refresh) }, 'Отмена')
    : el('button', { class: 'ghost', onclick: () => send({ type: 'removeJob', jobId: j.id }).then(refresh) }, '✕');

  return el('div', { class: 'card' },
    el('div', { class: 'job-head' }, el('div', { class: 'job-name', title: j.name }, j.name), btn),
    el('div', { class: 'progress' }, el('div', { style: `width:${pct.toFixed(1)}%` })),
    el('div', { class: 'job-meta' }, meta.join(' · ')),
    j.error ? el('div', { class: 'job-meta error' }, j.error) : null,
    j.status === 'done' && j.files.length > 1
      ? el('div', { class: 'job-meta' }, 'Видео и звук сохранены отдельно — см. README, как склеить через ffmpeg.')
      : null,
  );
}

init();
