'use strict';
// Anime Nusantara - server HTTP tanpa dependensi eksternal.
// Muat .env lokal lebih dulu supaya kunci API terbaca sebelum modul lain dimuat.
(function loadEnv() {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const cv = require('./lib/craftvel');
const catalog = require('./lib/catalog');
const episodes = require('./lib/episodes');
const streams = require('./lib/streams');
const donghua = require('./lib/anilist');
const scheduler = require('./lib/scheduler');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(payload);
}

function ok(res, data, extra = {}) {
  send(res, 200, Object.assign({ data }, extra));
}

function fail(res, status, code, message, extra = {}) {
  send(res, status, Object.assign({ error: { code, message } }, extra));
}

function parseCookies() {
  return {};
}

function serveStatic(req, res, pathname) {
  const rel = pathname.replace(/^\/+/, '') || 'index.html';
  const filePath = path.join(PUBLIC, rel);
  if (!filePath.startsWith(PUBLIC)) return fail(res, 403, 'FORBIDDEN', 'Akses ditolak');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // fallback SPA untuk rute seperti /anime/<slug>
      if (!path.extname(rel)) return serveIndex(res);
      return fail(res, 404, 'NOT_FOUND', 'Berkas tidak ditemukan');
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache, must-revalidate' });
    res.end(data);
  });
}

function serveIndex(res) {
  fs.readFile(path.join(PUBLIC, 'index.html'), (err, data) => {
    if (err) return fail(res, 500, 'INDEX_MISSING', 'index.html tidak ada');
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

// ---------- Detail cache ----------
const detailMemory = new Map();

async function getDetail(slug) {
  const cached = detailMemory.get(slug);
  const maxAge = cached && cached.data.status === 'ongoing' ? 15 * 60 * 1000 : 12 * 60 * 60 * 1000;
  if (cached && Date.now() - cached.at < maxAge) return cached.data;

  const r = await cv.get(`/v1/anime/${encodeURIComponent(slug)}`);
  if (!r.ok) {
    if (cached) return cached.data;
    const err = new Error(r.message);
    err.code = r.code;
    err.status = r.status;
    throw err;
  }
  const data = r.data;
  // setiap detail yang dibuka ikut memperkaya indeks katalog
  try {
    catalog.upsertMany([data]);
    catalog.persist();
  } catch (e) {}
  // strip field berat yang tidak dipakai UI
  delete data.episodes;
  delete data.episode_ranges;
  detailMemory.set(slug, { at: Date.now(), data });
  return data;
}

// ---------- Proxy video ----------
// Media host mengirim Alt-Svc h3 sehingga Chromium kadang memilih QUIC dan berhenti
// di readyState 0. Relay lewat server lokal membuat pemutaran konsisten.
// Tautan bisa kedaluwarsa di tengah sesi, jadi relay mencoba semua sumber lalu
// resolve ulang sekali sebelum menyerah (pemutar tidak mati permanen).
function openUpstream(target, headers, method) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const upReq = https.request(target, { method, headers, timeout: 25000 }, (up) => {
      if (up.statusCode >= 400) {
        up.resume();
        return done({ ok: false, status: up.statusCode });
      }
      done({ ok: true, up });
    });
    upReq.on('timeout', () => upReq.destroy(new Error('TIMEOUT')));
    upReq.on('error', (err) => done({ ok: false, status: 0, error: err.message }));
    upReq.end();
  });
}

async function proxyVideo(req, res, epSlug, q) {
  const wanted = q.get('q');
  let entry = streams.entry(epSlug);
  if (!entry) {
    const resolved = await streams.get(epSlug);
    if (!resolved.ok) {
      return fail(res, 503, resolved.code || 'MEDIA_UNAVAILABLE', 'Tautan video belum tersedia untuk episode ini.');
    }
    entry = resolved.entry;
  }

  const order = (servers) => {
    const list = (servers || []).filter((s) => s && s.url);
    const sorted = list.slice().sort((a, b) => (b.resolution || 0) - (a.resolution || 0));
    const preferred = wanted ? sorted.filter((s) => s.quality === wanted || s.label === wanted) : [];
    const out = [];
    for (const s of preferred.concat(sorted)) if (!out.some((x) => x.url === s.url)) out.push(s);
    return out.slice(0, 4);
  };

  const headers = { 'User-Agent': 'AnimeNusantara/1.0', Accept: '*/*' };
  if (req.headers.range) headers.Range = req.headers.range;
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';

  if (!order(entry.servers).length) return fail(res, 404, 'STREAM_NOT_FOUND', 'Tidak ada sumber video untuk episode ini.');

  let last = null;
  const tryAll = async (servers) => {
    for (const s of order(servers)) {
      if (res.writableEnded || res.destroyed) return null;
      const target = (() => {
        try {
          return new URL(s.url);
        } catch (err) {
          return null;
        }
      })();
      if (!target) continue;
      const attempt = await openUpstream(target, headers, method);
      if (attempt.ok) return attempt;
      last = { status: attempt.status, error: attempt.error, label: s.label || s.quality || 'sumber' };
      console.log(`[video] ${epSlug} gagal di ${last.label} (${last.status || last.error})`);
    }
    return null;
  };

  let hit = await tryAll(entry.servers);
  if (!hit) {
    const fresh = await streams.get(epSlug, { force: true }).catch(() => null);
    if (fresh && fresh.ok) hit = await tryAll(fresh.entry.servers);
  }
  if (!hit) {
    if (res.writableEnded || res.destroyed) return;
    return fail(
      res,
      502,
      last && last.status ? 'UPSTREAM_' + last.status : 'UPSTREAM_ERROR',
      last && last.status ? 'Server video menolak permintaan.' : 'Server video tidak bisa dihubungi.'
    );
  }

  const up = hit.up;
  const outHeaders = {
    'Content-Type': up.headers['content-type'] || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=0, no-transform',
  };
  if (up.headers['content-length']) outHeaders['Content-Length'] = up.headers['content-length'];
  if (up.headers['content-range']) outHeaders['Content-Range'] = up.headers['content-range'];
  res.writeHead(up.statusCode, outHeaders);
  up.pipe(res);
  up.on('error', () => res.destroy());
  res.on('close', () => {
    if (!res.writableFinished) up.destroy();
  });
}

// ---------- API ----------
let accountCache = { at: 0, usage: null, cap: null };

async function accountInfo() {
  if (Date.now() - accountCache.at < 60 * 1000) return accountCache;
  const usage = await cv.usage().catch(() => null);
  const cap = await cv.capabilities().catch(() => null);
  accountCache = { at: Date.now(), usage: usage || accountCache.usage, cap: cap || accountCache.cap };
  return accountCache;
}

async function apiStatus() {
  const account = await accountInfo();
  const usage = account.usage;
  const cap = account.cap;
  const epsCache = fs.existsSync(path.join(store.DATA_DIR, 'episodes'))
    ? fs.readdirSync(path.join(store.DATA_DIR, 'episodes')).length
    : 0;
  const home = scheduler.cachedHome();
  return {
    app: 'Anime Nusantara',
    uptimeSeconds: Math.round(process.uptime()),
    craftvel: {
      apiKeyConfigured: cv.hasKey(),
      plan: cap ? cap.plan : null,
      quality: cap ? cap.features : null,
      quota: usage ? { used: usage.quota_used, remaining: usage.quota_remaining, limit: usage.quota_limit, resets_at: usage.resets_at } : null,
    },
    catalog: catalog.stats(),
    episodeCache: { animeCached: epsCache },
    home: {
      generatedAt: home ? home.generatedAt : null,
      latest: home && home.latest ? home.latest.length : 0,
      ongoing: home && home.ongoing ? home.ongoing.length : 0,
      scheduleDays: home && home.schedule ? home.schedule.length : 0,
    },
    donghua: donghua.stats(),
    streams: streams.stats(),
    scheduler: scheduler.status(),
    now: new Date().toISOString(),
  };
}

async function apiHome() {
  const home = scheduler.cachedHome();
  if (!home) {
    const fresh = await scheduler.refreshHome();
    if (fresh.skipped) return { pending: true };
    return scheduler.cachedHome();
  }
  return home;
}

async function apiAnimeList(q) {
  const params = {
    q: q.get('q') || '',
    genre: q.get('genre') || '',
    status: q.get('status') || '',
    sort: q.get('sort') || 'latest',
    page: q.get('page') || 1,
    limit: q.get('limit') || 24,
  };
  let result = catalog.search(params);
  // Judul yang belum masuk indeks (mis. seri panjang yang tak muncul di daftar completed)
  // dicari langsung ke upstream lalu disimpan, supaya pencarian tidak pernah kosong.
  if (result.meta.total === 0 && params.q.trim()) {
    const up = await cv.get('/v1/anime/search?q=' + encodeURIComponent(params.q.trim()) + '&limit=50').catch(() => null);
    const found = up && up.ok ? (Array.isArray(up.data) ? up.data : up.data.items || []) : [];
    if (found.length) {
      catalog.upsertMany(found);
      catalog.persist();
      result = catalog.search(params);
    }
  }
  if (result.meta.total === 0 && catalog.size() === 0) {
    return { data: [], meta: result.meta, pending: true };
  }
  return result;
}

async function apiAnimeDetail(slug) {
  const base = await getDetail(slug);
  let eps = null;
  try {
    eps = await episodes.get(slug, { maxAgeMs: base.status === 'ongoing' ? 30 * 60 * 1000 : 24 * 60 * 60 * 1000 });
  } catch (err) {
    eps = { slug, count: 0, data: [], error: err.message };
  }
  const relations = Array.isArray(base.relations) ? base.relations : [];
  return Object.assign({}, base, {
    relations,
    episodes: eps ? eps.data : [],
    episodes_count: eps ? eps.count : 0,
    episodes_fetched_at: eps ? eps.fetchedAt : null,
    episodes_stale: Boolean(eps && eps.stale),
    episodes_error: eps && eps.error ? eps.error : null,
  });
}

async function apiEpisodes(slug, q) {
  const force = q.get('refresh') === '1';
  const payload = await episodes.get(slug, { force });
  return payload;
}

async function apiStream(epSlug, q) {
  const force = q.get('refresh') === '1';
  const result = await streams.get(epSlug, { force });
  if (!result.ok) {
    return {
      error: {
        code: result.code || 'MEDIA_UNAVAILABLE',
        message:
          result.code === 'MEDIA_UNAVAILABLE'
            ? 'Server video sedang tidak tersedia. Tekan "Coba lagi" sebentar lagi.'
            : result.code === 'STREAM_NOT_FOUND'
            ? 'Episode ini belum punya tautan video.'
            : 'Gagal memuat tautan video (' + (result.code || 'tidak diketahui') + ').',
      },
      tried: result.tried || [],
      quota: result.quota,
    };
  }
  const entry = result.entry;
  return {
    data: {
      episode: entry.episode,
      url: entry.url,
      servers: entry.servers,
      type: entry.type,
      fromCache: result.fromCache,
      verified: Boolean(result.verified),
      resolvedAt: entry.at,
      quota: entry.quota || null,
    },
  };
}

// Urutan jadwal: hari ini dulu, lalu hari mendatang, lalu yang belum dijadwalkan,
// terakhir hari yang sudah lewat (supaya halaman tidak dibuka dengan rilis kemarin).
function normalizeSchedule(days) {
  if (!Array.isArray(days)) return days;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rows = days.map((d) => {
    const raw = d && d.date ? Date.parse(String(d.date) + 'T00:00:00') : NaN;
    const ts = Number.isNaN(raw) ? null : raw;
    return {
      d: Object.assign({}, d, { is_today: ts === today.getTime(), is_past: ts !== null && ts < today.getTime() }),
      ts,
    };
  });
  const rank = (r) => (r.d.is_today ? 0 : r.ts === null ? 2 : r.d.is_past ? 3 : 1);
  rows.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 3) return (b.ts || 0) - (a.ts || 0);
    if (ra === 1) return (a.ts || 0) - (b.ts || 0);
    return 0;
  });
  return rows.map((r) => r.d);
}

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const q = url.searchParams;

  // ---- API ----
  if (pathname === '/api/status') return ok(res, await apiStatus());

  if (pathname === '/api/health') return ok(res, { ok: true, now: new Date().toISOString() });

  if (pathname === '/api/home') {
    const data = await apiHome();
    return ok(res, data);
  }

  if (pathname === '/api/anime') {
    const result = await apiAnimeList(q);
    return send(res, 200, Object.assign({ data: result.data }, { meta: result.meta, pending: result.pending || false }));
  }

  if (pathname === '/api/genres') {
    const saved = store.read('genres', null);
    if (saved && saved.length) return ok(res, saved.slice(0, 40));
    const r = await cv.get('/v1/anime/genres');
    if (r.ok) {
      const list = r.data.slice().sort((a, b) => b.count - a.count);
      store.write('genres', list);
      return ok(res, list.slice(0, 40));
    }
    return fail(res, 502, 'GENRES_UNAVAILABLE', r.message);
  }

  if (pathname === '/api/schedule') {
    const home = scheduler.cachedHome();
    if (home && home.schedule) return ok(res, normalizeSchedule(home.schedule));
    const r = await cv.get('/v1/anime/schedule');
    if (r.ok) return ok(res, normalizeSchedule(r.data));
    return fail(res, 502, r.code || 'SCHEDULE_UNAVAILABLE', r.message);
  }

  if (pathname.startsWith('/api/anime/')) {
    const rest = pathname.slice('/api/anime/'.length);
    if (rest.endsWith('/episodes')) {
      const slug = rest.slice(0, -'/episodes'.length);
      try {
        return ok(res, await apiEpisodes(slug, q));
      } catch (err) {
        return fail(res, err.status || 502, err.code || 'EPISODES_ERROR', err.message);
      }
    }
    try {
      return ok(res, await apiAnimeDetail(rest));
    } catch (err) {
      return fail(res, err.status && err.status !== 0 ? err.status : 502, err.code || 'ANIME_ERROR', err.message);
    }
  }

  if (pathname.startsWith('/api/stream/')) {
    const ep = pathname.slice('/api/stream/'.length);
    const payload = await apiStream(ep, q);
    if (payload.error) return send(res, 503, payload);
    return send(res, 200, payload);
  }

  if (pathname.startsWith('/api/video/')) {
    const ep = pathname.slice('/api/video/'.length);
    return proxyVideo(req, res, ep, q);
  }

  if (pathname === '/api/donghua') {
    const result = donghua.search({
      q: q.get('q') || '',
      status: q.get('status') || '',
      genre: q.get('genre') || '',
      sort: q.get('sort') || 'popular',
      page: q.get('page') || 1,
      limit: q.get('limit') || 24,
    });
    return send(res, 200, result);
  }

  if (pathname.startsWith('/api/donghua/')) {
    const id = pathname.slice('/api/donghua/'.length);
    const item = donghua.byId(id);
    if (!item) return fail(res, 404, 'NOT_FOUND', 'Judul donghua tidak ditemukan');
    return ok(res, item);
  }

  if (pathname === '/api/refresh') {
    const layer = q.get('layer') || 'home';
    if (layer === 'home') return ok(res, await scheduler.refreshHome());
    if (layer === 'episodes') return ok(res, await scheduler.refreshOngoingEpisodes());
    if (layer === 'donghua') return ok(res, await scheduler.refreshDonghua());
    if (layer === 'catalog') {
      const started = catalog.buildFull({ force: q.get('force') === '1' });
      started.catch(() => {});
      return ok(res, { started: true, message: 'indeks dibangun di latar belakang' });
    }
    return fail(res, 400, 'INVALID_LAYER', 'layer harus home|episodes|donghua|catalog');
  }

  if (pathname.startsWith('/api/')) return fail(res, 404, 'NOT_FOUND', 'Endpoint tidak ada');

  // ---- Halaman ----
  if (
    pathname === '/' ||
    pathname === '/anime' ||
    pathname === '/donghua' ||
    pathname === '/jadwal' ||
    pathname === '/ongoing' ||
    pathname === '/koleksi' ||
    pathname === '/favorit' ||
    pathname === '/riwayat'
  ) {
    return serveIndex(res);
  }
  if (/^\/(anime|nonton|donghua)\/[\w.-]+$/.test(pathname)) return serveIndex(res);

  if (pathname === '/favicon.ico') return send(res, 204, '');
  return serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.url && req.url.startsWith('/api/')) {
      const ms = Date.now() - started;
      if (ms > 1500) console.log(`[slow] ${req.method} ${req.url} ${res.statusCode} ${ms}ms`);
    }
  });
  router(req, res).catch((err) => {
    console.error('[server]', err);
    if (!res.headersSent) fail(res, 500, 'INTERNAL', err.message);
  });
});

function boot() {
  const size = catalog.load();
  console.log(`[boot] indeks katalog dimuat: ${size} anime`);
  const d = donghua.stats();
  console.log(`[boot] donghua tersimpan: ${d.total} judul (update: ${d.fetchedAt || 'belum ada'})`);
  server.listen(PORT, HOST, () => {
    console.log(`[boot] Anime Nusantara siap di http://${HOST}:${PORT}`);
    scheduler.start();
  });
}

if (require.main === module) boot();

module.exports = { server, boot, apiStatus, getDetail };
