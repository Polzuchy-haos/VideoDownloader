// Сборка расширения для Firefox и Chrome.
//   node tools/build.js
// Результат:
//   dist/firefox/                                  — распакованное расширение (MV2)
//   dist/chrome/                                   — распакованное расширение (MV3), «Загрузить распакованное»
//   dist/videodownloader-<версия>-firefox.xpi — архив для подписи на AMO / установки
//   dist/videodownloader-<версия>-chrome.zip  — архив для Chrome
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const COMMON = [
  'background.js',
  'lib',
  'popup',
  'icons',
  'content/picker.js',
  'content/relay.js',
];

const TARGETS = {
  firefox: {
    manifest: 'manifest.json',
    files: COMMON,
    archive: 'xpi',
  },
  chrome: {
    manifest: 'platform/chrome/manifest.json',
    files: [...COMMON, 'content/hook.js', 'offscreen'],
    archive: 'zip',
  },
};

function copy(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copy(path.join(src, name), path.join(dst, name));
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

// --- минимальный ZIP (deflate), без внешних зависимостей ---

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function zip(dir, outFile) {
  const { time, date } = dosDateTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const rel of listFiles(dir)) {
    const data = fs.readFileSync(path.join(dir, rel));
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const name = Buffer.from(rel, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 имена
    local.writeUInt16LE(8, 8);      // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(outFile, Buffer.concat([...locals, cd, end]));
}

// --- сборка ---

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
fs.rmSync(DIST, { recursive: true, force: true });

for (const [name, t] of Object.entries(TARGETS)) {
  const out = path.join(DIST, name);
  for (const f of t.files) copy(path.join(ROOT, f), path.join(out, f));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, t.manifest), 'utf8'));
  manifest.version = version; // одна версия на обе сборки — из корневого manifest.json
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const archive = path.join(DIST, `videodownloader-${version}-${name}.${t.archive}`);
  zip(out, archive);
  console.log(`${name.padEnd(8)} → ${path.relative(ROOT, out)}  +  ${path.relative(ROOT, archive)}`);
}
