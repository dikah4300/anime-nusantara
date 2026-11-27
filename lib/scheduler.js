'use strict';
// Penjadwal refresh: beranda/jadwal tiap 5 menit, episode ongoing bergilir, donghua tiap 12 jam.
const store = require('./store');
const cv = require('./craftvel');
const catalog = require('./catalog');
const episodes = require('./episodes');
const donghua = require('./anilist');

const HOME_INTERVAL = 5 * 60 * 1000;
const EPISODE_INTERVAL = 3 * 60 * 1000;
const DONGHUA_INTERVAL = 12 * 60 * 60 * 1000;
const ONGOING_PER_TICK = 5;

const flags = { home: false, episodes: false, donghua: false };
const timers = [];
const last = { home: null, episodes: null, donghua: null, catalog: null };
let rotation = 0;

function snapshotHome() {
  const out = {
    generatedAt: new Date().toISOString(),
    latest: null,
    ongoing: null,
    schedule: null,
  };
  return out;
}

async function refreshHome() {
  if (flags.home) return { skipped: true };
  flags.home = true;
  const out = snapshotHome();
  try {
    const [home, ongoing, schedule] = await Promise.all([
      cv.get('/v1/anime/home'),
      cv.get('/v1/anime/ongoing'),
      cv.get('/v1/anime/schedule'),
    ]);
    if (home.ok) {
      out.latest = (home.data.latest_episodes || []).slice(0, 24);
      if (home.data.popular) out.popular = home.data.popular;
      if (home.data.ongoing) out.ongoing_home = home.data.ongoing;
    }
    if (ongoing.ok) {
      const rows = ongoing.data.slice().sort((a, b) => {
        if (a.release_day && b.release_day) return 0;
        return (b.score || 0) - (a.score || 0);
      });
      out.ongoing = rows;
      catalog.upsertMany(rows);
    }
    if (schedule.ok) out.schedule = schedule.data;
    out.ok = Boolean(home.ok || ongoing.ok || schedule.ok);
    if (out.ok) {
      store.write('home', out);
      last.home = out.generatedAt;
    }
    return { ok: out.ok, generatedAt: out.generatedAt };
  } finally {
    flags.home = false;
  }
}

function cachedHome() {
  return store.read('home', null);
}

// Segarkan daftar episode untuk sebagian judul ongoing, bergilir tiap tick.
async function refreshOngoingEpisodes() {
  if (flags.episodes) return { skipped: true };
  flags.episodes = true;
  try {
    const home = cachedHome();
    const rows = (home && home.ongoing) || catalog.ongoingList();
    if (!rows.length) return { ok: true, refreshed: 0 };
    const batch = [];
    for (let i = 0; i < ONGOING_PER_TICK && rows.length; i++) {
      batch.push(rows[(rotation + i) % rows.length]);
    }
    rotation = (rotation + ONGOING_PER_TICK) % Math.max(rows.length, 1);
    let refreshed = 0;
    for (const row of batch) {
      if (!row || !row.slug) continue;
      try {
        const payload = await episodes.get(row.slug, { force: true });
        if (payload && payload.count) refreshed++;
      } catch (err) {
        console.error('[scheduler] episode gagal', row.slug, err.message);
      }
    }
    last.episodes = new Date().toISOString();
    return { ok: true, refreshed, rotation };
  } finally {
    flags.episodes = false;
  }
}

async function refreshDonghua() {
  if (flags.donghua) return { skipped: true };
  flags.donghua = true;
  try {
    const res = await donghua.refresh();
    last.donghua = new Date().toISOString();
    return res;
  } finally {
    flags.donghua = false;
  }
}

function start() {
  const home = cachedHome();
  const d = donghua.stats();

  // Guard: jangan dobel dengan tick pertama.
  if (!home || !home.generatedAt || Date.now() - Date.parse(home.generatedAt) > 60 * 1000) {
    refreshHome().catch((e) => console.error('[scheduler] home:', e.message));
  }
  if (!catalog.size() || catalog.size() < 500) {
    catalog.buildFull().catch((e) => console.error('[scheduler] katalog:', e.message));
  }
  setTimeout(() => refreshOngoingEpisodes().catch(() => {}), 20000);
  if (!d.fetchedAt || Date.now() - Date.parse(d.fetchedAt) > DONGHUA_INTERVAL) {
    setTimeout(() => refreshDonghua().catch(() => {}), 4000);
  }

  timers.push(setInterval(() => refreshHome().catch((e) => console.error('[scheduler] home:', e.message)), HOME_INTERVAL));
  timers.push(setInterval(() => refreshOngoingEpisodes().catch((e) => console.error('[scheduler] eps:', e.message)), EPISODE_INTERVAL));
  timers.push(setInterval(() => refreshDonghua().catch((e) => console.error('[scheduler] donghua:', e.message)), DONGHUA_INTERVAL));
  timers.forEach((t) => t.unref && t.unref());
}

function status() {
  const home = cachedHome();
  return {
    lastHome: last.home,
    homeGeneratedAt: home ? home.generatedAt : null,
    lastEpisodes: last.episodes,
    rotation,
    lastDonghua: last.donghua,
    busy: Object.assign({}, flags),
  };
}

module.exports = { start, refreshHome, refreshOngoingEpisodes, refreshDonghua, cachedHome, status };
