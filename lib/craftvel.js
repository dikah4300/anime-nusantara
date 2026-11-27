'use strict';
// Klien Craftvel API: pacing 2 rps, retry untuk 429/5xx, cache stream.
const https = require('https');

const BASE = 'https://api.craftvel.com';
const KEY = process.env.CRAFTVEL_API_KEY || '';
const MIN_GAP_MS = 620; // 2 rps di atas kertas, tapi 620ms terbukti aman

let lastCall = 0;
let queue = Promise.resolve();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Semua request diserialkan supaya tidak pernah menabrak rate limit upstream.
function pace(fn) {
  const next = queue.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    return fn();
  });
  queue = next.catch(() => {});
  return next;
}

function request(pathname, { method = 'GET', key = false, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + pathname);
    const headers = { Accept: 'application/json', 'User-Agent': 'AnimeNusantara/1.0' };
    if (key && KEY) headers['X-API-Key'] = KEY;
    const req = https.request(
      url,
      { method, headers, timeout },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch (err) {
            /* biarkan null */
          }
          resolve({ status: res.statusCode, json, body });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', reject);
    req.end();
  });
}

function isRetryable(status, code) {
  return status === 429 || status >= 500 || code === 'RATE_LIMITED' || code === 'MEDIA_UNAVAILABLE';
}

// get() mengembalikan { ok, status, data, code, message }
async function get(pathname, { key = false, attempts = 3, baseDelay = 1200 } = {}) {
  let last = { ok: false, status: 0, code: 'NETWORK', message: 'Tidak bisa menghubungi server katalog' };
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res;
    try {
      res = await pace(() => request(pathname, { key }));
    } catch (err) {
      last = { ok: false, status: 0, code: 'NETWORK', message: err.message };
      if (attempt < attempts - 1) await sleep(baseDelay * (attempt + 1));
      continue;
    }
    const json = res.json || {};
    if (res.status >= 200 && res.status < 300 && json.data !== undefined) {
      return { ok: true, status: res.status, data: json.data, meta: json.meta || {}, links: json.links || {} };
    }
    const code = (json.error && json.error.code) || 'HTTP_' + res.status;
    const message = (json.error && json.error.message) || 'Respons katalog tidak dikenal';
    last = { ok: false, status: res.status, code, message };
    if (!isRetryable(res.status, code) || attempt === attempts - 1) break;
    await sleep(baseDelay * Math.pow(1.6, attempt));
  }
  return last;
}

async function capabilities() {
  const r = await get('/v1/me/capabilities', { key: true, attempts: 1 });
  return r.ok ? r.data : null;
}

async function usage() {
  const r = await get('/v1/me/usage', { key: true, attempts: 1 });
  return r.ok ? r.data : null;
}

// Urutan: tanpa parameter (auto-pilih server sehat), lalu nama server yang dikenal.
const FALLBACK_SERVERS = ['Mirror-1', 'primary'];

async function resolveStream(episodeSlug, { knownServers = [] } = {}) {
  const tried = [];
  const candidates = [null];
  for (const name of knownServers.concat(FALLBACK_SERVERS)) {
    if (name && !candidates.includes(name)) candidates.push(name);
  }
  for (const server of candidates) {
    const qs = server ? '?server=' + encodeURIComponent(server) : '';
    const r = await get(`/v1/episodes/${encodeURIComponent(episodeSlug)}/stream${qs}`, {
      key: true,
      attempts: server === null ? 3 : 2,
      baseDelay: 1400,
    });
    tried.push({ server: server || 'auto', status: r.status, code: r.ok ? 'OK' : r.code });
    if (r.ok) return { ok: true, data: r.data, tried };
  }
  return { ok: false, tried, code: tried[tried.length - 1].code, status: tried[tried.length - 1].status };
}

module.exports = { get, resolveStream, capabilities, usage, pace, sleep, hasKey: () => Boolean(KEY) };
