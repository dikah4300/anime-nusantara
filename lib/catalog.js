'use strict';
// Indeks katalog lokal: semua anime dari upstream dipetakan ke memori + data/catalog.json
const store = require('./store');
const cv = require('./craftvel');

const PAGE_SIZE = 50;
const CATALOG_FILE = 'catalog';
const STATE_FILE = 'catalog-state';

let index = new Map();
let state = { builtAt: null, completedPagesDone: 0, completedPagesTotal: null, building: false, lastError: null };

function normalize(item) {
  return {
    slug: item.slug,
    title: item.title,
    title_english: item.title_english || null,
    poster_url: item.poster_url || null,
    score: typeof item.score === 'number' ? item.score : null,
    status: item.status || null,
    type: item.type || null,
    release_year: item.release_year || null,
    release_day: item.release_day || null,
    genres: Array.isArray(item.genres) ? item.genres : [],
    latest_episode: item.latest_episode || null,
    episodes_total: item.episodes_total || null,
  };
}

function load() {
  const saved = store.read(CATALOG_FILE, null);
  if (saved && Array.isArray(saved.items)) {
    for (const item of saved.items) index.set(item.slug, item);
  }
  const savedState = store.read(STATE_FILE, null);
  if (savedState) state = Object.assign(state, savedState, { building: false });
  return index.size;
}

function persist() {
  store.write(CATALOG_FILE, { items: Array.from(index.values()) });
  store.write(STATE_FILE, Object.assign({}, state, { size: index.size }));
}

function upsertMany(items) {
  let added = 0;
  for (const raw of items || []) {
    if (!raw || !raw.slug) continue;
    const prev = index.get(raw.slug);
    const next = normalize(raw);
    if (!prev) added++;
    // jangan biarkan data parsial menimpa field yang sudah lengkap
    index.set(raw.slug, Object.assign({}, prev || {}, next, {
      latest_episode: next.latest_episode || (prev && prev.latest_episode) || null,
      episodes_total: next.episodes_total || (prev && prev.episodes_total) || null,
      score: next.score != null ? next.score : prev ? prev.score : null,
    }));
  }
  return added;
}

function flattenSchedule(data) {
  // /v1/anime/schedule mengembalikan 8 hari; tiap hari berisi daftar anime.
  const out = [];
  const days = Array.isArray(data) ? data : Array.isArray(data && data.days) ? data.days : [];
  for (const day of days) {
    const list = Array.isArray(day) ? day : (day && (day.items || day.anime)) || [];
    if (Array.isArray(list)) out.push(...list);
  }
  return out;
}

// Bangun indeks lengkap: ongoing + popular + jadwal + seluruh halaman completed.
// Status akhir ditentukan dari dua sumber otoritatif: feed ongoing dan jadwal rilis.
// Tanpa ini, sweep "completed" menimpa status seri yang masih tayang.
async function buildFull({ force = false } = {}) {
  if (state.building) return { started: false, reason: 'sudah berjalan' };
  state.building = true;
  state.lastError = null;
  const started = Date.now();
  const ongoingSlugs = new Set();
  const completedSlugs = new Set();
  try {
    const ongoing = await cv.get('/v1/anime/ongoing');
    if (ongoing.ok) {
      upsertMany(ongoing.data);
      for (const it of ongoing.data || []) if (it.slug) ongoingSlugs.add(it.slug);
    }
    const popular = await cv.get('/v1/anime/popular?limit=50');
    if (popular.ok) upsertMany(popular.data);
    const sched = await cv.get('/v1/anime/schedule');
    if (sched.ok) {
      const flat = flattenSchedule(sched.data);
      upsertMany(flat);
      for (const it of flat) if (it.slug) ongoingSlugs.add(it.slug);
    }
    persist();

    let page = force ? 1 : (state.completedPagesDone || 1);
    let totalPages = state.completedPagesTotal || null;
    while (true) {
      const r = await cv.get(`/v1/anime/completed?page=${page}&limit=${PAGE_SIZE}`);
      if (!r.ok) {
        state.lastError = r.code + ': ' + r.message;
        break;
      }
      upsertMany(r.data);
      for (const it of r.data || []) if (it.slug) completedSlugs.add(it.slug);
      totalPages = (r.meta && r.meta.total_pages) || totalPages;
      state.completedPagesTotal = totalPages;
      state.completedPagesDone = page;
      if (page % 4 === 0) persist(); // simpan progres supaya tidak ulang dari nol
      if (!r.meta || !r.meta.has_next) break;
      page++;
      if (totalPages && page > totalPages) break;
    }

    let fixed = 0;
    for (const item of index.values()) {
      const shouldBe = ongoingSlugs.has(item.slug) ? 'ongoing' : completedSlugs.has(item.slug) ? 'completed' : item.status;
      if (shouldBe && item.status !== shouldBe) {
        item.status = shouldBe;
        fixed++;
      }
    }
    if (fixed) console.log(`[catalog] status diperbaiki: ${fixed} judul`);
    state.builtAt = new Date().toISOString();
    state.durationMs = Date.now() - started;
    console.log(`[catalog] indeks selesai: ${index.size} anime (${((state.durationMs) / 1000).toFixed(1)}s)`);
    return { started: true, size: index.size, pages: state.completedPagesDone, error: state.lastError };
  } catch (err) {
    state.lastError = err.message;
    return { started: true, error: err.message };
  } finally {
    state.building = false;
    persist();
  }
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Skor relevansi: judul persis > awalan judul > judul mengandung frasa > semua kata utuh > tanpa spasi > semua substring.
function relevance(a, rawQuery, tokens) {
  const title = String(a.title || '').toLowerCase();
  const english = String(a.title_english || '').toLowerCase();
  const hay = `${title} ${english} ${a.slug || ''}`;
  if (title === rawQuery || english === rawQuery) return 100;
  if (title.startsWith(rawQuery) || english.startsWith(rawQuery)) return 90;
  if (title.includes(rawQuery) || english.includes(rawQuery)) return 80;
  const bounded = tokens.every((t) => new RegExp('\\b' + escapeRe(t)).test(hay));
  if (bounded) return 60;
  // "doupo" harus ketemu "Dou Po Cangqiong": bandingkan tanpa spasi/tanda baca
  const squeeze = (s) => s.replace(/[^a-z0-9]/g, '');
  const compactQuery = squeeze(rawQuery);
  if (compactQuery.length >= 4 && squeeze(`${title} ${english}`).includes(compactQuery)) return 50;
  return 0;
}

function search({ q = '', genre = '', status = '', sort = 'latest', page = 1, limit = 24 } = {}) {
  const rawQuery = String(q || '').trim().toLowerCase();
  const needle = rawQuery;
  const tokens = needle.split(/\s+/).filter(Boolean);
  let rows = Array.from(index.values());
  const scores = new Map();
  if (needle) {
    rows = rows.filter((a) => {
      const score = relevance(a, needle, tokens);
      if (!score) return false;
      scores.set(a, score);
      return true;
    });
  }
  if (genre) rows = rows.filter((a) => (a.genres || []).some((g) => g.toLowerCase() === String(genre).toLowerCase()));
  if (status) rows = rows.filter((a) => (a.status || '').toLowerCase() === String(status).toLowerCase());

  const title = (a) => (a.title || a.slug || '').toLowerCase();
  const sorters = {
    title: (a, b) => title(a).localeCompare(title(b)),
    score: (a, b) => (b.score || 0) - (a.score || 0) || title(a).localeCompare(title(b)),
    newest: (a, b) => (b.release_year || 0) - (a.release_year || 0) || title(a).localeCompare(title(b)),
    episodes: (a, b) => (b.latest_episode || 0) - (a.latest_episode || 0),
    latest: (a, b) => {
      // ongoing dengan episode terbaru di atas, lalu skor
      const s = (b.status === 'ongoing') - (a.status === 'ongoing');
      if (s) return s;
      return (b.latest_episode || 0) - (a.latest_episode || 0) || (b.score || 0) - (a.score || 0);
    },
  };
  const scoreOf = (a) => (scores.has(a) ? scores.get(a) : 0);
  rows.sort((a, b) => {
    if (needle) {
      const diff = scoreOf(b) - scoreOf(a);
      if (diff) return diff;
    }
    return (sorters[sort] || sorters.latest)(a, b);
  });

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const perPage = Math.min(60, Math.max(1, parseInt(limit, 10) || 24));
  const total = rows.length;
  const start = (pageNum - 1) * perPage;
  return {
    data: rows.slice(start, start + perPage),
    meta: {
      total,
      page: pageNum,
      limit: perPage,
      total_pages: Math.ceil(total / perPage) || 0,
      has_next: start + perPage < total,
    },
  };
}

function bySlug(slug) {
  return index.get(slug) || null;
}

function size() {
  return index.size;
}

function ongoingList() {
  return Array.from(index.values()).filter((a) => a.status === 'ongoing');
}

function stats() {
  const all = Array.from(index.values());
  return {
    total: all.length,
    ongoing: all.filter((a) => a.status === 'ongoing').length,
    completed: all.filter((a) => a.status !== 'ongoing').length,
    builtAt: state.builtAt,
    pagesDone: state.completedPagesDone,
    pagesTotal: state.completedPagesTotal,
    building: state.building,
    lastError: state.lastError,
  };
}

module.exports = { load, persist, buildFull, search, bySlug, size, stats, ongoingList, upsertMany, state };
