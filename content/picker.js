'use strict';

// Выбор плеера на странице: подсветка iframe/video под курсором, клик — панель с потоками этого плеера.
(() => {
  if (window.__dcdl) {
    window.__dcdl.startPick();
    return;
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .layer { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; background: transparent; }
    .box {
      position: fixed; pointer-events: none; border: 3px solid #e8475f; border-radius: 6px;
      background: rgba(232, 71, 95, .12); transition: all .06s ease-out;
    }
    .box.flash { animation: flash .9s ease-out forwards; }
    @keyframes flash { from { opacity: 1; } to { opacity: 0; } }
    .tip {
      position: absolute; left: -3px; top: -30px; white-space: nowrap; max-width: 420px; overflow: hidden;
      text-overflow: ellipsis; background: #e8475f; color: #fff; font-weight: 600; padding: 4px 8px; border-radius: 6px 6px 0 0;
    }
    .banner {
      position: fixed; top: 12px; left: 50%; transform: translateX(-50%); pointer-events: none;
      background: #1c1b22; color: #fff; padding: 8px 14px; border-radius: 8px; box-shadow: 0 4px 18px rgba(0,0,0,.4);
    }
    .panel {
      position: fixed; top: 16px; right: 16px; width: 380px; max-height: calc(100vh - 32px); overflow: auto;
      pointer-events: auto; background: #1c1b22; color: #ececf1; border: 1px solid #3a3a45; border-radius: 10px;
      box-shadow: 0 8px 30px rgba(0,0,0,.5); padding: 0 10px 10px;
    }
    .head {
      display: flex; align-items: center; gap: 8px; position: sticky; top: 0; background: #1c1b22;
      padding: 10px 0 6px; cursor: move; user-select: none;
    }
    .head .title { flex: 1; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    button, select, input {
      color: inherit; background: #2a2a33; border: 1px solid #3a3a45; border-radius: 6px; padding: 4px 8px;
    }
    button { cursor: pointer; }
    button.primary { background: #e8475f; border-color: #e8475f; color: #fff; font-weight: 600; }
    button.ghost { background: transparent; }
    button:disabled { opacity: .5; cursor: default; }
    .card { background: #2a2a33; border: 1px solid #3a3a45; border-radius: 8px; padding: 8px; margin-top: 8px; }
    .card.best { border-color: #e8475f; }
    .row { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
    .row > input, .row > select { flex: 1; min-width: 0; }
    .badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 4px; background: #3a3a45; margin-right: 4px; }
    .badge.kodik { background: #3d7bd9; } .badge.alloha { background: #8d4bd6; } .badge.cvh { background: #d98a1f; }
    .badge.best { background: #e8475f; }
    .url { color: #a0a0ad; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
    .hint { color: #a0a0ad; }
    .error { color: #ff6b70; }
    .ok { color: #5fd08a; }
    .meta { font-size: 11px; color: #a0a0ad; margin-top: 4px; }
    .progress { height: 6px; border-radius: 3px; background: #3a3a45; overflow: hidden; margin-top: 6px; }
    .progress > div { height: 100%; background: #e8475f; transition: width .3s; }
    details { margin-top: 8px; }
    summary { cursor: pointer; color: #a0a0ad; }
    h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #a0a0ad; margin: 12px 0 0; }
  `;

  const PLAYER_FROM_HOST = [
    [/kodik|aniqit|anivod/i, 'Kodik'],
    [/alloha|newplayjj|stloadi/i, 'Alloha'],
    [/cdnvideohub|(^|\.)cvh/i, 'CVH'],
  ];

  let host, shadow;
  let layer, box, tip, banner, raf = 0, hovered = null;
  let panel, listBox, jobsBox, titleEl, pollTimer = 0;
  let picked = null; // { el, src, frameId }
  let streamsSig = '';
  let othersOpen = false;
  const ui = {};

  const api = globalThis.browser || globalThis.chrome;
  const send = msg => api.runtime.sendMessage(msg);

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

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('dcdl-root');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.append(el('style', {}, CSS));
    document.documentElement.append(host);
  }

  const isFrame = e => /^(IFRAME|FRAME|EMBED|OBJECT)$/.test(e.tagName);
  const isPickable = e => isFrame(e) || e.tagName === 'VIDEO';

  function hostOf(url) {
    try { return new URL(url, location.href).host; } catch { return ''; }
  }

  function describe(e) {
    if (e.tagName === 'VIDEO') return 'Видео на странице';
    const h = hostOf(e.src || e.data || '');
    const p = PLAYER_FROM_HOST.find(([re]) => re.test(h));
    return (p ? p[1] + ' — ' : '') + (h || 'iframe');
  }

  // ---------------------------------------------------------------------------
  // Режим выбора
  // ---------------------------------------------------------------------------

  function targetAt(x, y) {
    layer.style.pointerEvents = 'none';
    const stack = document.elementsFromPoint(x, y);
    layer.style.pointerEvents = '';
    for (const e of stack) {
      if (e !== host && isPickable(e)) return e;
    }
    // Плеер может быть накрыт оверлеем — ищем iframe/video внутри элементов под курсором.
    for (const e of stack) {
      if (e === host || e === document.body || e === document.documentElement) continue;
      for (const f of e.querySelectorAll('iframe, video')) {
        const r = f.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && r.width > 50) return f;
      }
    }
    return null;
  }

  function placeBox(target) {
    if (!target) { box.hidden = true; return; }
    const r = target.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    box.hidden = false;
  }

  function onMove(e) {
    if (raf) return;
    const { clientX: x, clientY: y } = e;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!layer) return;
      hovered = targetAt(x, y);
      if (hovered) tip.textContent = describe(hovered) + ' — кликните, чтобы выбрать';
      placeBox(hovered);
    });
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const t = targetAt(e.clientX, e.clientY);
    if (!t) return;
    stopPick();
    select(t);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      stopPick();
    }
  }

  const onScroll = () => placeBox(hovered);

  function startPick() {
    ensureHost();
    stopPick();
    layer = el('div', { class: 'layer', onmousemove: onMove, onclick: onClick });
    tip = el('div', { class: 'tip' });
    box = el('div', { class: 'box', hidden: true }, tip);
    banner = el('div', { class: 'banner' }, 'Наведите курсор на плеер и кликните. Esc — отмена.');
    shadow.append(layer, box, banner);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
  }

  function stopPick() {
    for (const n of [layer, box, banner]) n && n.remove();
    layer = box = tip = banner = null;
    hovered = null;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
  }

  function frameIdOf(e) {
    if (!isFrame(e)) return 0; // <video> прямо на странице — верхний документ
    try {
      if (api.runtime.getFrameId) return api.runtime.getFrameId(e); // только Firefox
    } catch {}
    return -1;
  }

  // Chrome: content script внутри iframe (content/relay.js) отвечает фону своим frameId.
  function ping() {
    if (!picked || !isFrame(picked.el) || picked.frameId >= 0) return;
    try { picked.el.contentWindow.postMessage({ __dcdlPing: picked.token }, '*'); } catch {}
  }

  function flash(target) {
    const r = target.getBoundingClientRect();
    const f = el('div', { class: 'box flash' });
    Object.assign(f.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    shadow.append(f);
    setTimeout(() => f.remove(), 1000);
  }

  function select(target) {
    picked = {
      el: target,
      src: target.src || target.data || location.href,
      frameId: frameIdOf(target),
      token: Math.random().toString(36).slice(2) + Date.now().toString(36),
    };
    ping();
    streamsSig = '';
    flash(target);
    openPanel();
  }

  // ---------------------------------------------------------------------------
  // Панель
  // ---------------------------------------------------------------------------

  function openPanel() {
    ensureHost();
    if (!panel) {
      titleEl = el('div', { class: 'title' });
      const head = el('div', { class: 'head' },
        titleEl,
        el('button', { class: 'ghost', title: 'Выбрать другой плеер', onclick: () => startPick() }, 'Выбрать'),
        el('button', { class: 'ghost', title: 'Закрыть', onclick: closePanel }, '✕'),
      );
      makeDraggable(head);
      listBox = el('div');
      jobsBox = el('div');
      panel = el('div', { class: 'panel' }, head, listBox, jobsBox);
      shadow.append(panel);
    }
    titleEl.textContent = describe(picked.el);
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, 1000);
    poll();
  }

  function closePanel() {
    clearInterval(pollTimer);
    pollTimer = 0;
    if (panel) panel.remove();
    panel = null;
    picked = null;
  }

  function makeDraggable(handle) {
    handle.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = ev => {
        panel.style.left = Math.max(0, ev.clientX - dx) + 'px';
        panel.style.top = Math.max(0, ev.clientY - dy) + 'px';
        panel.style.right = 'auto';
      };
      const up = () => {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('mouseup', up, true);
      };
      window.addEventListener('mousemove', move, true);
      window.addEventListener('mouseup', up, true);
      e.preventDefault();
    });
  }

  async function poll() {
    if (!picked || !panel) return;
    if (!picked.el.isConnected) {
      streamsSig = 'gone';
      listBox.replaceChildren(el('div', { class: 'card' },
        el('div', { class: 'hint' }, 'Плеер на странице был заменён (например, выбрана другая озвучка или плеер).'),
        el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => startPick() }, 'Выбрать плеер заново'))));
    } else if (isFrame(picked.el)) {
      const id = frameIdOf(picked.el);
      if (id >= 0) picked.frameId = id;
      else ping();
      picked.src = picked.el.src || picked.el.data || picked.src;
    }

    let st;
    try {
      st = await send({ type: 'getFrameState', frameId: picked.frameId, token: picked.token, src: picked.src });
    } catch {
      return;
    }
    if (!panel || !st || st.error) return;
    if (st.frameId != null && st.frameId >= 0 && picked.frameId < 0) picked.frameId = st.frameId;
    if (picked.el.isConnected) {
      if (st.player && st.player.id !== 'other') titleEl.textContent = st.player.name + ' — ' + hostOf(picked.src);
      const sig = st.streams.map(s => s.id + ':' + (s.probe ? s.probe.type : '') + (s.best ? '*' : '')).join(',');
      if (sig !== streamsSig) {
        streamsSig = sig;
        renderStreams(st.streams);
      }
    }
    renderJobs(st.jobs);
  }

  // ---------------------------------------------------------------------------

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
    return `${cleanTitle(document.title)} [${s.player.name}]${q}`;
  }

  function renderStreams(streams) {
    const main = streams.filter(s => !s.child);
    const children = streams.filter(s => s.child);
    if (!main.length) {
      listBox.replaceChildren(el('div', { class: 'card hint' },
        'Пока ничего не поймано. Нажмите Play в выбранном плеере — ссылка появится здесь автоматически.'));
      return;
    }
    const [best, ...rest] = main;
    const nodes = [renderStream(best, true)];
    const others = [...rest, ...children];
    if (others.length) {
      const det = el('details', { open: othersOpen },
        el('summary', {}, `Другие варианты (${others.length})`),
        others.map(s => renderStream(s, false)));
      det.addEventListener('toggle', () => { othersOpen = det.open; });
      nodes.push(det);
    }
    listBox.replaceChildren(...nodes);
  }

  function renderStream(s, isBest) {
    const st = ui[s.id] || (ui[s.id] = { name: defaultName(s), variant: null, audio: '' });
    const kindLabel = { hls: 'HLS', direct: 'MP4', dash: 'DASH' }[s.kind];
    const card = el('div', { class: 'card' + (isBest ? ' best' : '') },
      el('div', {},
        isBest ? el('span', { class: 'badge best' }, 'Рекомендуется') : null,
        el('span', { class: 'badge ' + s.player.id }, s.player.name),
        el('span', { class: 'badge' }, kindLabel),
        s.label ? el('span', {}, s.label + ' ') : null,
        s.size ? el('span', { class: 'hint' }, fmtBytes(s.size)) : null),
      el('div', { class: 'url', title: s.url }, s.url));

    if (s.kind === 'hls') card.append(renderHlsOptions(s, st));
    if (s.kind === 'dash') card.append(el('div', { class: 'row hint' }, 'DASH не поддерживается.'));

    const nameInput = el('input', { type: 'text', value: st.name, title: 'Имя файла (без расширения)' });
    nameInput.addEventListener('input', () => { st.name = nameInput.value; });
    const status = el('div', { class: 'meta' });
    const dlBtn = el('button', {
      class: 'primary',
      disabled: s.kind === 'dash',
      onclick: async () => {
        dlBtn.disabled = true;
        const res = await send({ type: 'download', streamId: s.id, filename: st.name, variantUrl: st.variant, audioUrl: st.audio || null });
        dlBtn.disabled = false;
        status.className = res.error ? 'meta error' : 'meta ok';
        status.textContent = res.error || 'Загрузка запущена';
        poll();
      },
    }, 'Скачать');
    card.append(el('div', { class: 'row' }, nameInput, dlBtn), status);
    return card;
  }

  function renderHlsOptions(s, st) {
    const p = s.probe;
    if (!p) return el('div', { class: 'row hint' }, 'Анализ плейлиста…');
    if (p.type === 'error') return el('div', { class: 'row error' }, 'Ошибка анализа: ' + p.error);
    if (p.type === 'media') {
      const info = [fmtDuration(p.duration), `${p.segments} сегм.`, p.encrypted ? 'AES-128' : null];
      return el('div', { class: 'row hint' }, info.filter(Boolean).join(' · '));
    }
    if (!st.variant || !p.variants.some(v => v.url === st.variant)) st.variant = p.variants[0]?.url || null;
    const frag = el('div');
    const qSel = el('select', {}, p.variants.map(v => el('option', { value: v.url, selected: v.url === st.variant }, v.label)));
    const audioRow = el('div', { class: 'row' });
    frag.append(el('div', { class: 'row' }, el('span', { class: 'hint' }, 'Качество:'), qSel), audioRow);
    const renderAudio = () => {
      audioRow.replaceChildren();
      const v = p.variants.find(x => x.url === st.variant);
      const tracks = p.audios.filter(a => !v || !v.audio || a.groupId === v.audio);
      if (!tracks.length) { st.audio = ''; return; }
      if (!tracks.some(a => a.url === st.audio)) st.audio = (tracks.find(a => a.isDefault) || tracks[0]).url;
      const aSel = el('select', {},
        el('option', { value: '' }, 'Без отдельной аудиодорожки'),
        tracks.map(a => el('option', { value: a.url, selected: a.url === st.audio }, a.name + (a.language ? ` (${a.language})` : ''))));
      aSel.addEventListener('change', () => { st.audio = aSel.value; });
      audioRow.append(el('span', { class: 'hint' }, 'Озвучка:'), aSel);
    };
    qSel.addEventListener('change', () => { st.variant = qSel.value; renderAudio(); });
    renderAudio();
    return frag;
  }

  const STATUS_TEXT = {
    running: 'Загрузка', saving: 'Сохранение', browser: 'Загружается браузером',
    done: 'Готово', error: 'Ошибка', cancelled: 'Отменено',
  };

  function renderJobs(jobs) {
    if (!jobs.length) { jobsBox.replaceChildren(); return; }
    jobsBox.replaceChildren(el('h3', {}, 'Загрузки'), ...jobs.map(j => {
      const active = ['running', 'saving', 'browser'].includes(j.status);
      let pct = j.total ? (j.done / j.total) * 100 : j.totalBytes > 0 ? (j.bytes / j.totalBytes) * 100 : 0;
      if (j.status === 'done') pct = 100;
      const secs = Math.max(1, (Date.now() - j.started) / 1000);
      const meta = [STATUS_TEXT[j.status] + (j.phase ? ` (${j.phase})` : '')];
      if (j.total) meta.push(`${j.done}/${j.total} сегм.`);
      if (j.bytes) meta.push(fmtBytes(j.bytes) + (j.totalBytes > 0 ? ' из ' + fmtBytes(j.totalBytes) : ''));
      if (j.status === 'running' && j.bytes) meta.push(fmtBytes(j.bytes / secs) + '/с');
      const btn = active
        ? el('button', { class: 'ghost', onclick: () => send({ type: 'cancel', jobId: j.id }).then(poll) }, 'Отмена')
        : el('button', { class: 'ghost', onclick: () => send({ type: 'removeJob', jobId: j.id }).then(poll) }, '✕');
      return el('div', { class: 'card' },
        el('div', { class: 'row', style: 'margin-top:0' }, el('div', { style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600', title: j.name }, j.name), btn),
        el('div', { class: 'progress' }, el('div', { style: `width:${pct.toFixed(1)}%` })),
        el('div', { class: 'meta' }, meta.join(' · ')),
        j.error ? el('div', { class: 'meta error' }, j.error) : null);
    }));
  }

  window.__dcdl = { startPick };
  startPick();
})();
