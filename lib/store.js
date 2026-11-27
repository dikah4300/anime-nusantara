'use strict';
// Penyimpanan JSON sederhana: baca/tulis atomik ke folder data/.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

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

module.exports = { read, write, mtime, DATA_DIR };
