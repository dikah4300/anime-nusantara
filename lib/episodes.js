'use strict';
// Cache daftar episode per anime, disimpan di data/episodes/<slug>.json
const fs = require('fs');
const path = require('path');
const store = require('./store');
const cv = require('./craftvel');

const DIR = path.join(store.DATA_DIR, 'episodes');
fs.mkdirSync(DIR, { recursive: true });

const memory = new Map(); // slug -> { fetchedAt, data }
const inflight = new Map();

function fileFor(slug) {
  return path.join(DIR, slug.replace(/[^a-z0-9._-]/gi, '_') + '.json');
}

function readDisk(slug) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(slug), 'utf8'));
  } catch (err) {
    return null;
  }
}

function writeDisk(slug, payload) {
  const file = fileFor(slug);
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[episodes] gagal simpan', slug, err.message);
  }
}

const MAX_AGE_MS = 6 * 60 * 60 * 1000; // episode baru muncul tiap hari; 6 jam cukup segar

function seasonNumber(title) {
  const t = String(title || '');
  const m = t.match(/\b(?:season|s)\s*(\d+)\b/i) || t.match(/\b(\d+)(?:nd|rd|th|st)\s+season\b/i);
  return m ? parseInt(m[1], 10) : 1;
}

function normalizeEpisodes(slug, items) {
  const rows = (items || [])
    .map((ep) => ({
      slug: ep.slug,
      episode_number: ep.episode_number,
      title: ep.title || `Episode ${ep.episode_number}`,
      released_at: ep.released_at || null,
      released_label: ep.released_label || null,
      label: ep.label || `Episode ${ep.episode_number}`,
      stream_url: ep.stream_url || `/v1/episodes/${ep.slug}/stream`,
    }))
    .sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0));
  return { slug, count: rows.length, fetchedAt: new Date().toISOString(), data: rows };
}

async function fetchFresh(slug) {
  const r = await cv.get(`/v1/anime/${encodeURIComponent(slug)}/episodes?limit=100&order=asc`);
  if (!r.ok) {
    const err = new Error(r.message || 'Gagal memuat episode');
    err.code = r.code;
    err.status = r.status;
    throw err;
  }
  let rows = r.data;
  // anime panjang (>100 episode) perlu halaman tambahan
  if (r.meta && r.meta.has_next) {
    let page = 2;
    while (page <= (r.meta.total_pages || 1) && page <= 20) {
      const next = await cv.get(`/v1/anime/${encodeURIComponent(slug)}/episodes?limit=100&order=asc&page=${page}`);
      if (!next.ok) break;
      rows = rows.concat(next.data);
      if (!next.meta || !next.meta.has_next) break;
      page++;
    }
  }
  const payload = normalizeEpisodes(slug, rows);
  writeDisk(slug, payload);
  memory.set(slug, payload);
  return payload;
}

async function get(slug, { maxAgeMs = MAX_AGE_MS, force = false } = {}) {
  const mem = memory.get(slug);
  const fresh = mem && Date.now() - Date.parse(mem.fetchedAt) < maxAgeMs;
  if (!force && fresh) return mem;

  const disk = !mem ? readDisk(slug) : null;
  if (disk && !force && Date.now() - Date.parse(disk.fetchedAt) < maxAgeMs) {
    memory.set(slug, disk);
    return disk;
  }

  if (inflight.has(slug)) return inflight.get(slug);
  const job = fetchFresh(slug)
    .catch((err) => {
      // sajikan cache lama kalau upstream gagal, jangan matikan halaman
      const fallback = disk || mem;
      if (fallback) return Object.assign({}, fallback, { stale: true, error: err.message });
      throw err;
    })
    .finally(() => inflight.delete(slug));
  inflight.set(slug, job);
  return job;
}

function cachedMeta(slug) {
  const mem = memory.get(slug);
  if (mem) return { count: mem.count, fetchedAt: mem.fetchedAt, stale: false };
  const disk = readDisk(slug);
  if (disk) {
    memory.set(slug, disk);
    return { count: disk.count, fetchedAt: disk.fetchedAt, stale: false };
  }
  return null;
}

module.exports = { get, cachedMeta, seasonNumber };
