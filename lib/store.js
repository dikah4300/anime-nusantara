'use strict';
// Penyimpanan JSON sederhana: baca/tulis atomik ke folder data/.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Di serverless (Vercel) filesystem proyek read-only, hanya /tmp yang bisa ditulis:
// folder data/ disalin sekali ke /tmp lalu seluruh cache dibaca/ditulis dari sana.
const BUNDLED_DIR = path.join(__dirname, '..', 'data');
const SERVERLESS = Boolean(process.env.VERCEL);
const DATA_DIR = SERVERLESS ? path.join(os.tmpdir(), 'anime-nusantara-data') : BUNDLED_DIR;

function copyTree(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
      copyTree(src, dst);
    } else if (!fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
    }
  }
}

function seed() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(BUNDLED_DIR)) copyTree(BUNDLED_DIR, DATA_DIR);
  } catch (err) {
    console.error('[store] gagal menyiapkan cache sementara:', err.message);
  }
}

if (SERVERLESS) seed();
else fs.mkdirSync(DATA_DIR, { recursive: true });

function fileFor(name) {
  return path.join(DATA_DIR, name.endsWith('.json') ? name : name + '.json');
}

function read(name, fallback) {
  const file = fileFor(name);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function write(name, value) {
  const file = fileFor(name);
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error('[store] gagal menulis', file, err.message);
    return false;
  }
}

function mtime(name) {
  try {
    return fs.statSync(fileFor(name)).mtime.toISOString();
  } catch (err) {
    return null;
  }
}

module.exports = { read, write, mtime, DATA_DIR, SERVERLESS };
