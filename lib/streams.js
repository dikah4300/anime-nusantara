'use strict';
// Resolusi tautan video: cache di data/streams.json supaya kuota API tidak terbuang.
const https = require('https');
const store = require('./store');
const cv = require('./craftvel');

const FILE = 'streams';
const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000;
const VERIFY_AFTER_MS = 20 * 60 * 1000; // setelah 20 menit, tautan dicek dulu sebelum dipakai

let cache = null;
let dirty = false;

function load() {
  if (cache) return cache;
  const saved = store.read(FILE, null);
  cache = saved && typeof saved === 'object' ? saved : {};
  return cache;
}

function flush() {
  if (!dirty) return;
  dirty = false;
  store.write(FILE, cache);
}

function save(epSlug, payload) {
  load();
  cache[epSlug] = payload;
  dirty = true;
  flush();
}

function entry(epSlug) {
  load();
  return cache[epSlug] || null;
}

// Cek tautan media masih hidup (tanpa memakai kuota API).
function probe(url) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return resolve({ ok: false, status: 0 });
    }
    const req = https.request(
      parsed,
      { method: 'GET', headers: { Range: 'bytes=0-1', 'User-Agent': 'AnimeNusantara/1.0' }, timeout: 12000 },
      (res) => {
        res.resume();
        resolve({ ok: res.statusCode === 200 || res.statusCode === 206, status: res.statusCode, type: res.headers['content-type'] || null });
      }
    );
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.end();
  });
}

function labelFor(item) {
  if (item.quality && item.server_name) return `${item.quality} · ${item.server_name}`;
  if (item.quality) return item.quality;
  if (item.label) return item.label;
  return 'Sumber';
}

// Bentuk respons API v2: { streams:[{resolution,quality,url,format,server_name}], expires_at }
function pickServers(data) {
  const list = [];
  const push = (row) => {
    if (!row || !row.url) return;
    if (list.some((x) => x.url === row.url)) return;
    list.push({
      label: labelFor(row),
      quality: row.quality || (row.resolution ? row.resolution + 'p' : null),
      resolution: row.resolution || null,
      format: row.format || null,
      server: row.server_name || null,
      url: row.url,
      available: row.status ? row.status === 'available' : true,
    });
  };

  if (Array.isArray(data.streams)) data.streams.forEach(push);
  if (Array.isArray(data.servers)) {
    data.servers.forEach((s) => {
      if (s && typeof s === 'object') push(s);
    });
  }
  if (data.url) push({ url: data.url, quality: data.quality, server_name: data.server });

  const usable = list.filter((s) => s.available);
  usable.sort((a, b) => (b.resolution || 0) - (a.resolution || 0));
  return usable.length ? usable : list;
}

async function get(epSlug, { force = false } = {}) {
  const cached = entry(epSlug);
  const now = Date.now();
  const expiresTs = cached && cached.expires_at ? Date.parse(cached.expires_at) : null;
  const freshUntil = expiresTs
    ? Math.min(expiresTs - 60 * 1000, now + DEFAULT_TTL_MS)
    : cached
    ? Date.parse(cached.at) + DEFAULT_TTL_MS
    : 0;
  const age = cached ? now - Date.parse(cached.at) : Infinity;

  if (!force && cached && now < freshUntil) {
    if (age < VERIFY_AFTER_MS) return { ok: true, entry: cached, fromCache: true, verified: false };
    const check = await probe(cached.url);
    if (check.ok) return { ok: true, entry: cached, fromCache: true, verified: true, probe: check.status };
    console.log(`[stream] tautan cache mati (${check.status}) untuk ${epSlug}, resolve ulang`);
  }

  const known = cached && Array.isArray(cached.server_names) ? cached.server_names : [];
  const result = await cv.resolveStream(epSlug, { knownServers: known });
  if (!result.ok) {
    const usage = await cv.usage();
    return {
      ok: false,
      code: result.code || 'MEDIA_UNAVAILABLE',
      status: result.status,
      tried: result.tried,
      quota: usage ? usage.quota_remaining : null,
    };
  }

  const data = result.data || {};
  const servers = pickServers(data);
  if (!servers.length) {
    return { ok: false, code: 'STREAM_NOT_FOUND', status: 404, tried: result.tried };
  }
  const payload = {
    episode: epSlug,
    anime: data.anime || null,
    next_episode: data.next_episode || null,
    prev_episode: data.prev_episode || null,
    url: servers[0].url,
    servers,
    server_names: Array.isArray(data.servers) ? data.servers.filter((s) => typeof s === 'string') : [],
    type: 'video',
    server: data.server || null,
    expires_at: data.expires_at || null,
    at: new Date().toISOString(),
    tried: result.tried,
  };
  save(epSlug, payload);
  const usage = await cv.usage();
  if (usage) {
    payload.quota = {
      used: usage.quota_used,
      remaining: usage.quota_remaining,
      limit: usage.quota_limit,
      resets_at: usage.resets_at,
    };
    save(epSlug, payload);
  }
  return { ok: true, entry: payload, fromCache: false };
}

function stats() {
  load();
  const rows = Object.values(cache);
  const recent = rows
    .slice()
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 8)
    .map((r) => ({ episode: r.episode, at: r.at, quality: (r.servers && r.servers[0] && r.servers[0].quality) || null }));
  return { cached: rows.length, lastResolved: recent[0] ? recent[0].at : null, recent };
}

module.exports = { get, stats, probe, entry };
