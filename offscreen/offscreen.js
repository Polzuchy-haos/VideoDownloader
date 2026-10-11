'use strict';

// Chrome: здесь живёт загрузчик HLS. Service worker не умеет создавать blob URL и засыпает,
// а offscreen-документ работает, пока открыт, и держит готовые файлы до сохранения.

const pendingBlobs = new Map(); // downloadId -> blob URL

const send = msg => browser.runtime.sendMessage(msg);

const engine = new Engine({
  allowHeaders: async (urls, stream) => {
    const res = await send({ type: 'allowHeaders', urls, stream: { referer: stream.referer, origin: stream.origin } });
    if (res && res.error) throw new Error(res.error);
  },
  save: async (blob, filename, saveAs) => {
    const url = URL.createObjectURL(blob);
    const res = await send({ type: 'saveBlob', url, filename, saveAs }).catch(e => ({ error: e.message }));
    if (!res || res.error) {
      URL.revokeObjectURL(url);
      throw new Error(res ? res.error : 'нет ответа от фонового скрипта');
    }
    pendingBlobs.set(res.id, url);
    // Подстраховка, если service worker перезапустился и не сообщил о завершении.
    setTimeout(() => revoke(res.id), 60 * 60 * 1000);
  },
});

function revoke(id) {
  const url = pendingBlobs.get(id);
  if (!url) return;
  pendingBlobs.delete(id);
  URL.revokeObjectURL(url);
}

// Пока идут загрузки, не даём service worker уснуть: любое сообщение продлевает ему жизнь.
setInterval(() => {
  if (engine.active) send({ type: 'keepalive' }).catch(() => {});
}, 20000);

onMessage(msg => {
  if (!msg || msg.target !== 'offscreen') return undefined;
  switch (msg.type) {
    case 'start':
      return { ok: true, jobId: engine.start(msg.spec) };
    case 'list':
      return engine.list();
    case 'cancel':
      engine.cancel(msg.jobId);
      return { ok: true };
    case 'remove':
      engine.remove(msg.jobId);
      return { ok: true };
    case 'downloadDone':
      setTimeout(() => revoke(msg.id), 5000);
      return { ok: true };
  }
  return undefined;
});
