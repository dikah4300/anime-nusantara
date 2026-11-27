'use strict';
// Katalog donghua (animasi Tiongkok) via AniList GraphQL + tautan platform resmi.
const https = require('https');
const store = require('./store');

const FILE = 'donghua';
const PAGES = 8; // 8 x 50 = 400 judul terpopuler, cukup untuk katalog yang bisa ditelusuri
const PER_PAGE = 50;

const PLATFORM_LABEL = {
  Bilibili: 'Bilibili (resmi)',
  Bstation: 'Bstation (resmi)',
  iQIYI: 'iQIYI (resmi)',
  WeTV: 'WeTV (resmi)',
  Youku: 'Youku (resmi)',
  Tencent: 'Tencent Video (resmi)',
  'Tencent Video': 'Tencent Video (resmi)',
  'Muse Asia': 'YouTube Muse Asia',
  'Muse Indonesia': 'YouTube Muse Indonesia',
  Netflix: 'Netflix',
  Crunchyroll: 'Crunchyroll',
  Viu: 'Viu',
  'Vision+': 'Vision+',
  Catchplay: 'Catchplay+',
  'Catchplay+': 'Catchplay+',
  Aniplus: 'ANIPLUS',
};

const PLATFORM_ORDER = [
  'Bstation', 'Bilibili', 'iQIYI', 'WeTV', 'Youku', 'Tencent', 'Tencent Video',
  'Muse Indonesia', 'Muse Asia', 'Netflix', 'Crunchyroll', 'Viu', 'Vision+', 'Catchplay', 'Catchplay+',
];

const QUERY = `query ($page: Int) {
  Page(page: $page, perPage: ${PER_PAGE}) {
    pageInfo { hasNextPage total }
    media(type: ANIME, countryOfOrigin: "CN", sort: POPULARITY_DESC, isAdult: false) {
      id
      idMal
      title { romaji english native }
      description(asHtml: false)
      episodes
      duration
      status
      seasonYear
      format
      synonyms
      averageScore
      popularity
      genres
      coverImage { extraLarge large }
      bannerImage
      nextAiringEpisode { episode airingAt }
      externalLinks { site url type language }
    }
  }
}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function graphql(query, variables) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request(
      'https://graphql.anilist.co',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'AnimeNusantara/1.0',
        },
        timeout: 25000,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(text);
            if (json.errors && json.errors.length) return reject(new Error(json.errors[0].message));
            resolve(json.data);
          } catch (err) {
            reject(new Error('Respons AniList tidak valid (' + res.statusCode + ')'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', reject);
    req.end(body);
  });
}

function clean(text) {
  if (!text) return null;
  return String(text)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&mdash;/g, '-')
    .replace(/&ndash;/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\s*\(Source:[^)]*\)\s*/gi, ' ')
    .replace(/\s*Note:[^.]*\.?\s*$/i, ' ')
    .trim();
}

function officialLinks(links) {
  const out = [];
  for (const link of links || []) {
    if (!link || link.type !== 'STREAMING' || !link.url) continue;
    const label = PLATFORM_LABEL[link.site] || link.site;
    if (out.some((o) => o.url === link.url || o.label === label)) continue;
    out.push({ site: link.site, label, url: link.url });
  }
  const rank = (site) => {
    const i = PLATFORM_ORDER.indexOf(site);
    return i === -1 ? 99 : i;
  };
  return out.sort((a, b) => rank(a.site) - rank(b.site));
}

function normalize(media) {
  const statusMap = { RELEASING: 'ongoing', FINISHED: 'completed', NOT_YET_RELEASED: 'upcoming', CANCELLED: 'cancelled', HIATUS: 'hiatus' };
  return {
    id: media.id,
    slug: 'donghua-' + media.id,
    mal_id: media.idMal || null,
    title: media.title.english || media.title.romaji || media.title.native,
    title_romaji: media.title.romaji,
    title_native: media.title.native,
    synonyms: Array.isArray(media.synonyms) ? media.synonyms : [],
    synopsis: clean(media.description),
    episodes: media.episodes || null,
    duration: media.duration || null,
    format: media.format,
    status_raw: media.status,
    status: statusMap[media.status] || String(media.status || '').toLowerCase(),
    release_year: media.seasonYear || null,
    score: media.averageScore ? Math.round(media.averageScore) / 10 : null,
    popularity: media.popularity || 0,
    genres: media.genres || [],
    poster_url: (media.coverImage && (media.coverImage.extraLarge || media.coverImage.large)) || null,
    banner_url: media.bannerImage || null,
    next_airing_at: media.nextAiringEpisode ? new Date(media.nextAiringEpisode.airingAt * 1000).toISOString() : null,
    next_airing_episode: media.nextAiringEpisode ? media.nextAiringEpisode.episode : null,
    links: officialLinks(media.externalLinks),
    source: 'AniList',
    source_url: 'https://anilist.co/anime/' + media.id,
  };
}

let state = { fetching: false, lastError: null };

async function refresh() {
  if (state.fetching) return { started: false, reason: 'sudah berjalan' };
  state.fetching = true;
  state.lastError = null;
  const items = new Map();
  try {
    for (let page = 1; page <= PAGES; page++) {
      let payload = null;
      for (let attempt = 0; attempt < 3 && !payload; attempt++) {
        try {
          payload = await graphql(QUERY, { page });
        } catch (err) {
          state.lastError = err.message;
          await sleep(1500 * (attempt + 1));
        }
      }
      if (!payload || !payload.Page) break;
      for (const media of payload.Page.media || []) {
        const row = normalize(media);
        items.set(row.id, row);
      }
      if (!payload.Page.pageInfo || !payload.Page.pageInfo.hasNextPage) break;
      await sleep(700); // hormati rate limit AniList (90 req/menit)
    }
    if (items.size === 0) {
      const prev = store.read(FILE, null);
      if (prev && prev.items) return { started: true, count: prev.items.length, cached: true, error: state.lastError };
      return { started: true, count: 0, error: state.lastError || 'AniList tidak mengembalikan data' };
    }
    const rows = Array.from(items.values()).sort((a, b) => b.popularity - a.popularity);
    const payload = { fetchedAt: new Date().toISOString(), count: rows.length, items: rows };
    store.write(FILE, payload);
    cache = payload; // penting: cache memori ikut diperbarui
    return { started: true, count: rows.length, fetchedAt: payload.fetchedAt };
  } catch (err) {
    state.lastError = err.message;
    return { started: true, error: err.message };
  } finally {
    state.fetching = false;
  }
}

let cache = null;
function all() {
  if (cache) return cache;
  const saved = store.read(FILE, null);
  cache = saved || { fetchedAt: null, count: 0, items: [] };
  return cache;
}

function search({ q = '', status = '', genre = '', sort = 'popular', page = 1, limit = 24 } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  let rows = all().items.slice();
  if (needle) {
    const tokens = needle.split(/\s+/).filter(Boolean);
    const squeeze = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const compactNeedle = squeeze(needle);
    rows = rows.filter((a) => {
      const hay = [a.title, a.title_romaji, a.title_native, (a.synonyms || []).join(' '), (a.genres || []).join(' ')].filter(Boolean).join(' ').toLowerCase();
      if (tokens.every((t) => hay.includes(t))) return true;
      // "doupo" -> "Dou Po Cangqiong", "battlethroughtheheavens" -> judul lengkap
      return compactNeedle.length >= 4 && squeeze(hay).includes(compactNeedle);
    });
  }
  if (genre) rows = rows.filter((a) => (a.genres || []).some((g) => g.toLowerCase() === String(genre).toLowerCase()));
  if (status) rows = rows.filter((a) => a.status === status);

  const sorters = {
    popular: (a, b) => b.popularity - a.popularity,
    score: (a, b) => (b.score || 0) - (a.score || 0),
    newest: (a, b) => (b.release_year || 0) - (a.release_year || 0),
    title: (a, b) => String(a.title || '').localeCompare(String(b.title || '')),
    episodes: (a, b) => (b.episodes || 0) - (a.episodes || 0),
  };
  rows.sort(sorters[sort] || sorters.popular);

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
      fetchedAt: all().fetchedAt,
    },
  };
}

function byId(id) {
  const item = all().items.find((a) => String(a.id) === String(id) || a.slug === 'donghua-' + id);
  return item || null;
}

function stats() {
  const items = all().items;
  return {
    total: items.length,
    ongoing: items.filter((a) => a.status === 'ongoing').length,
    withOfficialLink: items.filter((a) => (a.links || []).length > 0).length,
    fetchedAt: all().fetchedAt,
    fetching: state.fetching,
    lastError: state.lastError,
  };
}

module.exports = { refresh, search, byId, stats, all, state };
