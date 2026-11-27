'use strict';
/* Anime Nusantara - SPA tanpa framework */

const view = document.getElementById('view');
const state = {
  home: null,
  lastQuery: null,
};

/* ---------------- util ---------------- */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function api(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  let body = null;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error('Respons server tidak valid (' + res.status + ')');
  }
  if (!res.ok) {
    const err = new Error((body.error && body.error.message) || 'Permintaan gagal (' + res.status + ')');
    err.code = (body.error && body.error.code) || 'HTTP_' + res.status;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function fmtDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtScore(score) {
  if (score == null || Number.isNaN(Number(score))) return null;
  return Number(score).toFixed(1);
}

function daysUntil(value) {
  if (!value) return null;
  const diff = Date.parse(value) - Date.now();
  if (Number.isNaN(diff)) return null;
  const total = Math.max(0, Math.floor(diff / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d} hari ${h} jam lagi`;
  if (h > 0) return `${h} jam ${m} menit lagi`;
  return `${m} menit lagi`;
}

/* ---------------- penyimpanan lokal (riwayat & favorit) ---------------- */
const HISTORY_KEY = 'an:history';
const BOOKMARK_KEY = 'an:bookmarks';
const WATCHED_KEY = 'an:watched';
const HISTORY_LIMIT = 50;

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch (err) {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    /* abaikan kuota penuh */
  }
}

function getHistory() {
  const list = readJson(HISTORY_KEY, []);
  return Array.isArray(list) ? list : [];
}

function upsertHistory(entry) {
  if (!entry || !entry.animeSlug || !entry.episodeSlug) return;
  const list = getHistory().filter((item) => item && item.animeSlug !== entry.animeSlug);
  list.unshift(Object.assign({}, entry, { updatedAt: entry.updatedAt || Date.now() }));
  if (list.length > HISTORY_LIMIT) list.length = HISTORY_LIMIT;
  writeJson(HISTORY_KEY, list);
}

function removeHistoryItem(animeSlug) {
  const list = getHistory().filter((item) => item && item.animeSlug !== animeSlug);
  writeJson(HISTORY_KEY, list);
}

function clearHistory() {
  writeJson(HISTORY_KEY, []);
}

function getBookmarks() {
  const list = readJson(BOOKMARK_KEY, []);
  return Array.isArray(list) ? list : [];
}

function isBookmarked(kind, id) {
  return getBookmarks().some((b) => b && b.kind === kind && String(b.id) === String(id));
}

function toggleBookmark(item) {
  if (!item || !item.kind || item.id == null) return false;
  const list = getBookmarks();
  const idx = list.findIndex((b) => b && b.kind === item.kind && String(b.id) === String(item.id));
  if (idx >= 0) {
    list.splice(idx, 1);
    writeJson(BOOKMARK_KEY, list);
    return false;
  }
  list.unshift(
    Object.assign({}, item, {
      id: String(item.id),
      addedAt: Date.now(),
    })
  );
  writeJson(BOOKMARK_KEY, list);
  return true;
}

function removeBookmark(kind, id) {
  const list = getBookmarks().filter((b) => !(b && b.kind === kind && String(b.id) === String(id)));
  writeJson(BOOKMARK_KEY, list);
}

function getWatchedSet(animeSlug) {
  const map = readJson(WATCHED_KEY, {});
  const arr = map && Array.isArray(map[animeSlug]) ? map[animeSlug] : [];
  return new Set(arr);
}

function markEpisodeWatched(animeSlug, epSlug) {
  if (!animeSlug || !epSlug) return;
  const map = readJson(WATCHED_KEY, {});
  const cur = Array.isArray(map[animeSlug]) ? map[animeSlug] : [];
  if (!cur.includes(epSlug)) {
    cur.push(epSlug);
    map[animeSlug] = cur;
    writeJson(WATCHED_KEY, map);
  }
}

function calcProgressPct(item) {
  if (!item) return 0;
  if (item.completed) return 100;
  if (!item.duration || item.duration <= 0) return item.position > 0 ? 12 : 0;
  return Math.max(4, Math.min(100, Math.round((item.position / item.duration) * 100)));
}

function fmtRelativeTime(ts) {
  if (!ts) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'Baru saja';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins} menit lalu`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} hari lalu`;
  return fmtDate(ts) || '';
}


function loading(text) {
  view.innerHTML = `<div class="loading-block" role="status">
    <div class="skeleton-line w40"></div>
    <div class="skeleton-line w70"></div>
    <p class="muted">${esc(text || 'Memuat...')}</p>
  </div>`;
}

function errorBlock(err, retryLabel) {
  return `<div class="notice err" role="alert">
    <strong>${esc(err.code || 'GAGAL')}</strong> ${esc(err.message || 'Terjadi kesalahan')}
    ${retryLabel ? `<div style="margin-top:10px"><button class="btn" id="retry-btn">${esc(retryLabel)}</button></div>` : ''}
  </div>`;
}

function animeCard(a, opts = {}) {
  const badge = a.status === 'ongoing' ? '<span class="card-badge">Ongoing</span>' : '';
  const epBadge = a.latest_episode ? `<span class="card-badge ep">Ep ${esc(a.latest_episode)}</span>` : '';
  const poster = a.poster_url
    ? `<img src="${esc(a.poster_url)}" alt="Poster ${esc(a.title)}" loading="lazy" width="300" height="450">`
    : '<div class="card-poster"></div>';
  const sub = [opts.sub || null, a.score ? '★ ' + fmtScore(a.score) : null, a.release_year || null]
    .filter(Boolean)
    .join(' · ');
  return `<article class="card">
    <a class="card-link" href="/anime/${esc(a.slug)}" data-link>
      <div class="card-poster">${poster}${badge}${epBadge}</div>
      <h3 class="card-title">${esc(a.title)}</h3>
      <p class="card-sub">${esc(sub || (a.type || ''))}</p>
    </a>
  </article>`;
}

function donghuaCard(a) {
  const badge = a.status === 'ongoing' ? '<span class="card-badge">Ongoing</span>' : '';
  const epBadge = a.episodes ? `<span class="card-badge ep">${esc(a.episodes)} eps</span>` : '';
  const poster = a.poster_url
    ? `<img src="${esc(a.poster_url)}" alt="Poster ${esc(a.title)}" loading="lazy" width="300" height="450">`
    : '<div class="card-poster"></div>';
  const sub = [a.score ? '★ ' + fmtScore(a.score) : null, a.release_year || null, a.links && a.links.length ? 'Resmi' : null]
    .filter(Boolean)
    .join(' · ');
  return `<article class="card">
    <a class="card-link" href="/donghua/${esc(a.id)}" data-link>
      <div class="card-poster">${poster}${badge}${epBadge}</div>
      <h3 class="card-title">${esc(a.title)}</h3>
      <p class="card-sub">${esc(sub || 'Donghua')}</p>
    </a>
  </article>`;
}

function pager(meta, onPage) {
  if (!meta || meta.total_pages <= 1) return '';
  return `<div class="pager">
    <button type="button" data-page="${meta.page - 1}" ${meta.page <= 1 ? 'disabled' : ''}>Sebelumnya</button>
    <span class="page-info">Halaman ${meta.page} dari ${meta.total_pages}</span>
    <button type="button" data-page="${meta.page + 1}" ${meta.has_next ? '' : 'disabled'}>Berikutnya</button>
  </div>`;
}

/* ---------------- routing ---------------- */
function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  render();
}

document.addEventListener('click', (ev) => {
  const link = ev.target.closest('a[data-link]');
  if (!link) return;
  if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
  const href = link.getAttribute('href');
  if (!href || !href.startsWith('/')) return;
  ev.preventDefault();
  navigate(href);
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
});

window.addEventListener('popstate', () => render());

document.getElementById('global-search').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const q = document.getElementById('q').value.trim();
  navigate('/anime' + (q ? '?q=' + encodeURIComponent(q) : ''));
});

function setActiveNav(name) {
  document.querySelectorAll('.main-nav a').forEach((a) => {
    if (a.dataset.nav === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

/* ---------------- beranda ---------------- */
async function renderHome() {
  setActiveNav('home');
  loading('Memuat beranda...');
  let home;
  try {
    if (state.home) {
      home = state.home;
    } else {
      const body = await api('/api/home');
      home = body && body.data ? body.data : body;
    }
    state.home = home;
  } catch (err) {
    view.innerHTML = errorBlock(err, 'Muat ulang');
    document.getElementById('retry-btn').onclick = () => renderHome();
    return;
  }
  if (!home || home.pending) {
    view.innerHTML = '<div class="notice warn">Katalog sedang disiapkan untuk pertama kali. Muat ulang halaman ini dalam beberapa detik.</div>';
    return;
  }

  const latest = (home.latest || []).filter((ep) => ep.anime && ep.slug);
  const ongoing = (home.ongoing || []).slice(0, 12);
  const popular = (home.popular || []).slice(0, 12);
  const hero = latest[0];

  let html = '';

  if (hero) {
    html += `<section class="hero">
      <div class="hero-media">
        <img src="${esc(hero.anime.poster_url || '')}" alt="" aria-hidden="true">
      </div>
      <div class="hero-body">
        <p class="small muted">Episode terbaru · ${esc(hero.released_label || fmtDate(hero.released_at) || '')}</p>
        <h1>${esc(hero.anime.title)}</h1>
        <div class="hero-meta">
          <span>${esc(hero.label || 'Episode ' + hero.episode_number)}</span>
          <span>Sub Indo</span>
          <span>Update otomatis tiap 5 menit</span>
        </div>
        <div class="hero-actions">
          <a class="btn btn-primary" href="/nonton/${esc(hero.slug)}" data-link>Tonton sekarang</a>
          <a class="btn" href="/anime/${esc(hero.anime.slug)}" data-link>Semua episode</a>
        </div>
      </div>
    </section>`;
  }

  html += '<div id="continue-section">' + buildContinueSection() + '</div>';

  html += `<section>
    <div class="section-head">
      <h2>Episode terbaru</h2>
      <p>${latest.length ? latest.length + ' rilis terakhir dari server katalog' : 'Belum ada rilis'}</p>
    </div>
    <div class="grid">
      ${latest
        .slice(0, 12)
        .map((ep) => {
          const a = ep.anime || {};
          const sub = [ep.label || 'Episode ' + ep.episode_number, fmtDate(ep.released_at)].filter(Boolean).join(' · ');
          const poster = a.poster_url
            ? `<img src="${esc(a.poster_url)}" alt="Poster ${esc(a.title || '')}" loading="lazy" width="300" height="450">`
            : '';
          return `<article class="card">
            <a class="card-link" href="/nonton/${esc(ep.slug)}" data-link>
              <div class="card-poster">${poster}<span class="card-badge ep">Ep ${esc(ep.episode_number)}</span></div>
              <h3 class="card-title">${esc(a.title || ep.title)}</h3>
              <p class="card-sub">${esc(sub)}</p>
            </a>
          </article>`;
        })
        .join('')}
    </div>
  </section>`;

  if (ongoing.length) {
    html += `<section>
      <div class="section-head">
        <h2>Sedang tayang</h2>
        <a href="/ongoing" data-link>Lihat semua ongoing</a>
      </div>
      <div class="grid">
        ${ongoing
          .map((a) =>
            animeCard(a, {
              sub: [a.release_day ? 'Tayang ' + a.release_day : null, a.latest_episode ? 'Ep ' + a.latest_episode : null]
                .filter(Boolean)
                .join(' · '),
            })
          )
          .join('')}
      </div>
    </section>`;
  }

  if (popular.length) {
    html += `<section>
      <div class="section-head">
        <h2>Populer</h2>
        <a href="/anime?sort=score" data-link>Peringkat lengkap</a>
      </div>
      <div class="grid">
        ${popular.map((a) => animeCard(a)).join('')}
      </div>
    </section>`;
  }

  html += `<section>
    <div class="section-head">
      <h2>Jelajahi katalog</h2>
      <p>Semua judul, semua episode, tanpa iklan</p>
    </div>
    <div class="link-list">
      <a class="link-card" href="/anime" data-link>Katalog anime <span class="ext">ribuan judul</span></a>
      <a class="link-card" href="/ongoing" data-link>Anime ongoing <span class="ext">update tiap hari</span></a>
      <a class="link-card" href="/donghua" data-link>Donghua <span class="ext">animasi Tiongkok</span></a>
      <a class="link-card" href="/jadwal" data-link>Jadwal rilis <span class="ext">7 hari</span></a>
      <a class="link-card" href="/koleksi" data-link>Koleksi Anda <span class="ext">favorit &amp; riwayat</span></a>
    </div>
  </section>`;

  view.innerHTML = html;
  bindContinueSection();
}

function buildContinueSection() {
  const items = getHistory().slice(0, 6);
  if (!items.length) return '';
  return `<section>
    <div class="section-head">
      <h2>Lanjutkan menonton</h2>
      <a href="/riwayat" data-link>Semua riwayat</a>
    </div>
    <div class="grid">
      ${items
        .map((item) => {
          const pct = calcProgressPct(item);
          const epNum = item.episodeNumber != null ? item.episodeNumber : '';
          const timeText = item.completed
            ? 'Selesai'
            : item.position > 0
            ? formatTime(item.position) + (item.duration > 0 ? ' / ' + formatTime(item.duration) : '')
            : fmtRelativeTime(item.updatedAt);
          const sub = [epNum !== '' ? 'Ep ' + epNum : item.episodeLabel, timeText].filter(Boolean).join(' · ');
          const poster = item.posterUrl
            ? `<img src="${esc(item.posterUrl)}" alt="Poster ${esc(item.title)}" loading="lazy" width="300" height="450">`
            : '';
          return `<article class="card card-actions-wrap">
            <button class="card-remove" type="button" data-remove-history="${esc(item.animeSlug)}" title="Hapus dari lanjutkan menonton" aria-label="Hapus ${esc(item.title)} dari lanjutkan menonton">&times;</button>
            <a class="card-link" href="/nonton/${esc(item.episodeSlug)}" data-link>
              <div class="card-poster">
                ${poster}
                ${epNum !== '' ? `<span class="card-badge ep">Ep ${esc(epNum)}</span>` : ''}
                ${pct > 0 ? `<div class="progress-track" aria-hidden="true"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
              </div>
              <h3 class="card-title">${esc(item.title)}</h3>
              <p class="card-sub">${esc(sub)}</p>
            </a>
          </article>`;
        })
        .join('')}
    </div>
  </section>`;
}

function bindContinueSection() {
  const host = document.getElementById('continue-section');
  if (!host) return;
  host.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-remove-history]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    removeHistoryItem(btn.dataset.removeHistory);
    host.innerHTML = buildContinueSection();
  });
}

/* ---------------- katalog ---------------- */
function catalogControls(params) {
  const genres = state.genres || [];
  const genreOptions =
    '<option value="">Semua genre</option>' +
    genres.map((g) => `<option value="${esc(g.name)}" ${params.genre === g.name ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
  const statusOptions = ['', 'ongoing', 'completed']
    .map((s) => {
      const label = s === '' ? 'Semua status' : s === 'ongoing' ? 'Ongoing' : 'Selesai';
      return `<option value="${s}" ${params.status === s ? 'selected' : ''}>${label}</option>`;
    })
    .join('');
  const sortOptions = [
    ['latest', 'Terbaru diperbarui'],
    ['score', 'Skor tertinggi'],
    ['newest', 'Tahun terbaru'],
    ['title', 'Judul A-Z'],
    ['episodes', 'Episode terbanyak'],
  ]
    .map(([v, l]) => `<option value="${v}" ${params.sort === v ? 'selected' : ''}>${l}</option>`)
    .join('');

  return `<form class="toolbar" id="catalog-form">
    <div class="field" style="flex:1 1 240px">
      <label for="c-q">Judul</label>
      <input id="c-q" name="q" type="search" value="${esc(params.q || '')}" placeholder="Ketik judul atau kata kunci">
    </div>
    <div class="field">
      <label for="c-genre">Genre</label>
      <select id="c-genre" name="genre">${genreOptions}</select>
    </div>
    <div class="field">
      <label for="c-status">Status</label>
      <select id="c-status" name="status">${statusOptions}</select>
    </div>
    <div class="field">
      <label for="c-sort">Urutkan</label>
      <select id="c-sort" name="sort">${sortOptions}</select>
    </div>
    <button class="btn btn-primary" type="submit">Terapkan</button>
  </form>`;
}

function bindCatalogForm(basePath, params) {
  const form = document.getElementById('catalog-form');
  if (!form) return;
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const data = new FormData(form);
    const qs = new URLSearchParams();
    for (const [k, v] of data.entries()) {
      if (v && v !== 'latest') qs.set(k, v);
    }
    navigate(basePath + (qs.toString() ? '?' + qs.toString() : ''));
  });
  // auto-apply untuk select
  form.querySelectorAll('select').forEach((sel) => {
    sel.addEventListener('change', () => form.requestSubmit());
  });
}

async function renderCatalog(params) {
  setActiveNav('anime');
  loading('Memuat katalog...');
  if (!state.genres) {
    try {
      const g = await api('/api/genres');
      state.genres = g.data || [];
    } catch (err) {
      state.genres = [];
    }
  }

  let payload;
  try {
    const qs = new URLSearchParams();
    ['q', 'genre', 'status', 'sort', 'page', 'limit'].forEach((k) => {
      if (params[k]) qs.set(k, params[k]);
    });
    payload = await api('/api/anime?' + qs.toString());
  } catch (err) {
    view.innerHTML = errorBlock(err, 'Coba lagi');
    document.getElementById('retry-btn').onclick = () => renderCatalog(params);
    return;
  }

  const rows = payload.data || [];
  const meta = payload.meta || {};

  let html = `<div class="section-head">
    <h1>Katalog anime</h1>
    <p>${meta.total ? meta.total.toLocaleString('id-ID') + ' judul' : 'Katalog'}</p>
  </div>`;

  if (payload.pending) {
    html += '<div class="notice warn">Indeks katalog sedang dibangun dari server sumber. Coba lagi dalam beberapa detik.</div>';
  }

  html += catalogControls(params);

  html += rows.length
    ? `<div class="grid">${rows.map((a) => animeCard(a)).join('')}</div>`
    : `<div class="empty"><p>Tidak ada judul yang cocok dengan filter itu.</p>
       <p class="small">Coba kata kunci lebih pendek, misalnya "jujutsu" atau "tensei". Kalau yang dicari donghua, buka menu <a href="/donghua" data-link>Donghua</a>.</p></div>`;

  html += pager(meta);
  view.innerHTML = html;
  bindCatalogForm('/anime', params);

  const pagerEl = view.querySelector('.pager');
  if (pagerEl) {
    pagerEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-page]');
      if (!btn || btn.disabled) return;
      const next = new URLSearchParams(params);
      next.set('page', btn.dataset.page);
      navigate('/anime?' + next.toString());
      window.scrollTo({ top: 0 });
    });
  }
}

async function renderOngoing(params) {
  setActiveNav('ongoing');
  params.status = 'ongoing';
  await renderCatalog(params);
  setActiveNav('ongoing');
  const h1 = view.querySelector('h1');
  if (h1) h1.textContent = 'Anime ongoing';
  const sub = view.querySelector('.section-head p');
  if (sub) sub.textContent = (sub.textContent || '') + ' · diperbarui otomatis';
}

/* ---------------- detail anime ---------------- */
function bookmarkButtonHtml(kind, id) {
  const saved = isBookmarked(kind, id);
  return `<button class="btn btn-fav ${saved ? 'active' : ''}" type="button" id="fav-btn" aria-pressed="${saved ? 'true' : 'false'}">
    ${saved ? '★ Tersimpan di favorit' : '☆ Simpan ke favorit'}
  </button>`;
}

function bindBookmarkButton(item) {
  const btn = document.getElementById('fav-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const saved = toggleBookmark(item);
    btn.classList.toggle('active', saved);
    btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
    btn.textContent = saved ? '★ Tersimpan di favorit' : '☆ Simpan ke favorit';
  });
}

function episodeGrid(eps, currentSlug, animeSlug) {
  if (!eps.length) return '<p class="muted">Belum ada episode untuk judul ini.</p>';
  const watched = animeSlug ? getWatchedSet(animeSlug) : new Set();
  return `<div class="episode-grid">${eps
    .map((ep) => {
      const isCurrent = ep.slug === currentSlug;
      const isWatched = watched.has(ep.slug);
      const cls = ['ep-btn', isCurrent ? 'current' : '', isWatched ? 'watched' : ''].filter(Boolean).join(' ');
      const title = [ep.title || 'Episode ' + ep.episode_number, isWatched ? '(sudah ditonton)' : ''].filter(Boolean).join(' ');
      return `<a class="${cls}" href="/nonton/${esc(ep.slug)}" data-link title="${esc(title)}">${esc(ep.episode_number)}</a>`;
    })
    .join('')}</div>`;
}

async function renderDetail(slug) {
  setActiveNav('anime');
  loading('Memuat detail anime...');
  let d;
  try {
    d = await api('/api/anime/' + encodeURIComponent(slug));
  } catch (err) {
    view.innerHTML = errorBlock(err, 'Coba lagi');
    document.getElementById('retry-btn').onclick = () => renderDetail(slug);
    return;
  }
  const data = d.data;
  const eps = data.episodes || [];
  const lastEp = eps[eps.length - 1];
  const histItem = getHistory().find((h) => h.animeSlug === data.slug);
  const savedEp = (histItem && histItem.episodeSlug) || localStorage.getItem('anime:last:' + data.slug);
  const resumeEp = eps.find((e) => e.slug === savedEp) || lastEp;

  const countdownText = data.next_airing_at
    ? `${daysUntil(data.next_airing_at) || ''} <span class="muted">(Episode ${esc(data.next_airing_episode || '?')} · ${esc(fmtDate(data.next_airing_at) || '')})</span>`
    : null;

  view.innerHTML = `<div>
    <div class="detail-head">
      <div class="detail-poster">
        ${data.poster_url ? `<img src="${esc(data.poster_url)}" alt="Poster ${esc(data.title)}" width="440" height="660">` : ''}
      </div>
      <div>
        <h1 class="detail-title">${esc(data.title)}</h1>
        ${data.title_english && data.title_english !== data.title ? `<p class="detail-alt">${esc(data.title_english)}</p>` : ''}
        ${data.title_japanese ? `<p class="detail-alt small">${esc(data.title_japanese)}</p>` : ''}
        <div class="meta-row">
          ${data.status === 'ongoing' ? '<span class="tag live">Ongoing</span>' : '<span class="tag">Selesai</span>'}
          ${data.score ? `<span class="tag score">★ ${fmtScore(data.score)}</span>` : ''}
          ${data.type ? `<span class="tag">${esc(data.type)}</span>` : ''}
          ${data.release_year ? `<span class="tag">${esc(data.release_year)}</span>` : ''}
          ${data.release_day ? `<span class="tag">Tayang ${esc(data.release_day)}</span>` : ''}
          ${data.episodes_count ? `<span class="tag">${esc(data.episodes_count)} episode tersedia</span>` : ''}
          ${data.episodes_total ? `<span class="tag">Total ${esc(data.episodes_total)} episode</span>` : ''}
        </div>
        <div class="meta-row">
          ${(data.genres || []).map((g) => `<a class="tag" href="/anime?genre=${encodeURIComponent(g)}" data-link>${esc(g)}</a>`).join('')}
        </div>
        ${countdownText ? `<div class="countdown"><span>Episode berikutnya</span><strong>${countdownText}</strong></div>` : ''}
        <p class="synopsis">${esc(data.synopsis || 'Sinopsis belum tersedia.')}</p>
        <div class="hero-actions">
          ${resumeEp ? `<a class="btn btn-primary" href="/nonton/${esc(resumeEp.slug)}" data-link>${savedEp ? 'Lanjutkan episode ' + esc(resumeEp.episode_number) : 'Tonton episode terakhir'}</a>` : ''}
          ${lastEp && !savedEp ? `<a class="btn" href="/nonton/${esc(lastEp.slug)}" data-link>Episode terbaru</a>` : ''}
          ${bookmarkButtonHtml('anime', data.slug)}
          <a class="btn btn-ghost" href="/anime?q=${encodeURIComponent(data.title)}" data-link>Judul serupa</a>
        </div>
      </div>
    </div>

    ${data.episodes_stale ? '<div class="notice warn">Daftar episode memakai cache terakhir karena server sumber belum merespons.</div>' : ''}
    ${data.episodes_error ? `<div class="notice err">Gagal memperbarui daftar episode: ${esc(data.episodes_error)}</div>` : ''}

    <section class="episode-box">
      <div class="episode-box-head">
        <h2 style="margin:0">Daftar episode</h2>
        <p class="small muted" style="margin:0">${eps.length} episode · Sub Indo</p>
      </div>
      ${episodeGrid(eps, null, data.slug)}
    </section>

    ${(data.relations || []).length ? `<section style="margin-top:32px">
      <div class="section-head"><h2>Terhubung</h2></div>
      <div class="grid">
        ${data.relations
          .filter((r) => r.anime && r.anime.slug)
          .slice(0, 12)
          .map((r) => animeCard(Object.assign({ status: null }, r.anime), { sub: relLabel(r.relation) }))
          .join('')}
      </div>
    </section>` : ''}
  </div>`;

  bindBookmarkButton({
    kind: 'anime',
    id: data.slug,
    title: data.title,
    posterUrl: data.poster_url || '',
    score: data.score || null,
    status: data.status || null,
    releaseYear: data.release_year || null,
    episodesCount: data.episodes_count || eps.length || null,
  });
}

function relLabel(rel) {
  const map = { PREQUEL: 'Prequel', SEQUEL: 'Sequel', SIDE_STORY: 'Side story', SPIN_OFF: 'Spin-off', ALTERNATIVE: 'Alternatif', SUMMARY: 'Ringkasan', PARENT: 'Induk' };
  return map[rel] || rel;
}

/* ---------------- pemutar ---------------- */
let currentPlayer = null;

async function renderPlayer(epSlug) {
  setActiveNav('anime');
  loading('Menyiapkan pemutar...');
  const guessedSlug = epSlug.replace(/-episode-\d+$/, '');
  let detail = null;
  let stream = null;
  let streamErr = null;

  try {
    detail = (await api('/api/anime/' + encodeURIComponent(guessedSlug))).data;
  } catch (err) {
    detail = null;
  }

  try {
    stream = await api('/api/stream/' + encodeURIComponent(epSlug));
  } catch (err) {
    streamErr = err;
  }

  const animeSlug = (detail && detail.slug) || guessedSlug;
  const eps = (detail && detail.episodes) || [];
  const idx = eps.findIndex((e) => e.slug === epSlug);
  const current = idx >= 0 ? eps[idx] : null;
  const prev = idx > 0 ? eps[idx - 1] : null;
  const next = idx >= 0 && idx < eps.length - 1 ? eps[idx + 1] : null;
  const title = (detail && detail.title) || (current && current.title) || epSlug;
  const watchedSet = getWatchedSet(animeSlug);

  const servers = (stream && stream.data && stream.data.servers) || [];
  const proxyBase = '/api/video/' + encodeURIComponent(epSlug);
  const src = servers.length ? proxyBase + '?q=' + encodeURIComponent(servers[0].quality || '') : '';

  view.innerHTML = `<div class="player-page">
    <div>
      <div class="player-shell">
        <video class="player-video" id="video" controls playsinline preload="metadata"
          ${detail && detail.poster_url ? `poster="${esc(detail.poster_url)}"` : ''} ${src ? `src="${esc(src)}"` : ''}></video>
        <div class="player-bar">
          <a class="btn" href="/anime/${esc(animeSlug)}" data-link>Detail anime</a>
          ${prev ? `<a class="btn" href="/nonton/${esc(prev.slug)}" data-link>Episode ${esc(prev.episode_number)}</a>` : '<button class="btn" disabled>Episode sebelumnya</button>'}
          ${next ? `<a class="btn btn-primary" href="/nonton/${esc(next.slug)}" data-link>Episode ${esc(next.episode_number)}</a>` : '<button class="btn" disabled>Episode berikutnya</button>'}
          <span class="player-status" id="player-status">${servers.length ? servers.length + ' sumber video' : ''}</span>
        </div>
        <div id="player-error"></div>
      </div>

      <h1 style="margin:20px 0 6px">${esc(title)}</h1>
      <p class="muted" style="margin:0 0 16px">
        ${current ? esc(current.label || 'Episode ' + current.episode_number) : esc(epSlug)}
        ${current && current.released_at ? ' · rilis ' + esc(fmtDate(current.released_at)) : ''}
        · Sub Indo
      </p>

      <div class="hero-actions" id="server-actions" role="group" aria-label="Pilih kualitas video">
        ${servers
          .map(
            (s, i) =>
              `<button class="chip ${i === 0 ? 'active' : ''}" type="button" data-quality="${esc(s.quality || '')}" aria-pressed="${i === 0}">${esc(s.label || s.quality || 'Sumber ' + (i + 1))}</button>`
          )
          .join('')}
      </div>
      ${stream && stream.data && stream.data.quota ? `<p class="small muted">Kuota API: sisa ${esc(stream.data.quota.remaining)} dari ${esc(stream.data.quota.limit)} resolusi episode bulan ini.</p>` : ''}
    </div>

    <aside class="ep-side">
      <div class="ep-side-head">${eps.length ? 'Daftar episode (' + eps.length + ')' : 'Daftar episode'}</div>
      <div class="ep-side-list" id="ep-side-list">
        ${
          eps.length
            ? eps
                .map((e) => {
                  const cls = ['item', e.slug === epSlug ? 'active' : '', watchedSet.has(e.slug) ? 'watched' : ''].filter(Boolean).join(' ');
                  return `<a class="${cls}" href="/nonton/${esc(e.slug)}" data-link>
                    <span class="num">${esc(e.episode_number)}</span>
                    <span>Episode ${esc(e.episode_number)}</span>
                    ${e.released_at ? `<span class="date">${esc(e.released_at)}</span>` : ''}
                  </a>`;
                })
                .join('')
            : '<p class="item muted">Episode tidak dapat dimuat.</p>'
        }
      </div>
    </aside>
  </div>`;

  document.title = title + ' - Anime Nusantara';
  if (idx >= 0) {
    const active = view.querySelector('#ep-side-list .item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  // tombol kualitas
  const serverActions = document.getElementById('server-actions');
  if (serverActions) {
    serverActions.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-quality]');
      if (!btn) return;
      const video = document.getElementById('video');
      const time = video.currentTime;
      const quality = btn.dataset.quality;
      video.src = proxyBase + (quality ? '?q=' + encodeURIComponent(quality) : '');
      video.load();
      video.addEventListener('loadedmetadata', () => {
        if (time > 0.5) video.currentTime = time;
        video.play().catch(() => {});
      }, { once: true });
      serverActions.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
    });
  }

  const video = document.getElementById('video');
  const errBox = document.getElementById('player-error');
  const statusEl = document.getElementById('player-status');

  function showError(message, code, canRetry) {
    errBox.innerHTML = `<div class="player-error" role="alert">
      <p><strong>${esc(code || 'GAGAL')}</strong> ${esc(message)}</p>
      ${canRetry ? '<button class="btn btn-primary" type="button" id="retry-stream">Coba lagi</button>' : ''}
    </div>`;
    const retry = document.getElementById('retry-stream');
    if (retry) {
      retry.onclick = async () => {
        errBox.innerHTML = '';
        statusEl.textContent = 'Menghubungi server video...';
        try {
          const fresh = await api('/api/stream/' + encodeURIComponent(epSlug) + '?refresh=1');
          const best = (fresh.data.servers && fresh.data.servers[0]) || null;
          video.src = '/api/video/' + encodeURIComponent(epSlug) + (best && best.quality ? '?q=' + encodeURIComponent(best.quality) : '');
          video.load();
          await video.play().catch(() => {});
          statusEl.textContent = 'Tersambung ulang';
        } catch (err) {
          showError(err.message, err.code, true);
        }
      };
    }
  }

  function saveHistorySnapshot(pos, dur, completed) {
    const epNumMatch = epSlug.match(/-episode-(\d+)$/);
    const episodeNumber = current ? current.episode_number : epNumMatch ? Number(epNumMatch[1]) : null;
    upsertHistory({
      animeSlug,
      title,
      posterUrl: (detail && detail.poster_url) || '',
      episodeSlug: epSlug,
      episodeNumber,
      episodeLabel: (current && current.label) || (episodeNumber != null ? 'Episode ' + episodeNumber : epSlug),
      position: Math.max(0, Math.floor(pos || 0)),
      duration: dur && !Number.isNaN(dur) ? Math.floor(dur) : 0,
      completed: Boolean(completed),
      updatedAt: Date.now(),
    });
    localStorage.setItem('anime:last:' + animeSlug, epSlug);
  }

  if (streamErr) {
    showError(streamErr.message, streamErr.code, true);
  } else if (!src) {
    showError('Tautan video tidak tersedia untuk episode ini.', 'STREAM_NOT_FOUND', true);
  }

  if (src) {
    // resume posisi
    const key = 'anime:pos:' + epSlug;
    const saved = parseFloat(localStorage.getItem(key) || '0');
    let lastSavedAt = 0;

    video.addEventListener('loadedmetadata', () => {
      if (saved > 15 && !Number.isNaN(video.duration) && saved < video.duration - 10) {
        video.currentTime = saved;
        statusEl.textContent = 'Melanjutkan dari ' + formatTime(saved);
      }
      saveHistorySnapshot(video.currentTime || saved, video.duration, false);
    }, { once: true });

    video.addEventListener('timeupdate', () => {
      if (video.currentTime >= 5 && Date.now() - lastSavedAt >= 4000) {
        lastSavedAt = Date.now();
        localStorage.setItem(key, String(Math.floor(video.currentTime)));
        saveHistorySnapshot(video.currentTime, video.duration, false);
        markEpisodeWatched(animeSlug, epSlug);
      }
    });
    video.addEventListener('error', () => {
      const code = video.error ? video.error.code : 0;
      const map = {
        1: 'Pemuatan video dibatalkan.',
        2: 'Koneksi ke server video terputus.',
        3: 'Video tidak bisa didekode perangkat ini.',
        4: 'Format video tidak didukung atau tautan kedaluwarsa.',
      };
      showError(map[code] || 'Terjadi kesalahan pemutaran.', 'VIDEO_ERROR_' + code, true);
    });
    video.addEventListener('playing', () => {
      errBox.innerHTML = '';
      saveHistorySnapshot(video.currentTime, video.duration, false);
    });
    video.addEventListener('ended', () => {
      localStorage.removeItem('anime:pos:' + epSlug);
      markEpisodeWatched(animeSlug, epSlug);
      saveHistorySnapshot(video.duration || 0, video.duration || 0, true);
      if (next) {
        statusEl.innerHTML = `<a href="/nonton/${esc(next.slug)}" data-link>Episode ${esc(next.episode_number)} siap diputar</a>`;
      }
    });
  }
}

function formatTime(secs) {
  const s = Math.max(0, Math.floor(secs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}

/* ---------------- donghua ---------------- */
async function renderDonghuaList(params) {
  setActiveNav('donghua');
  loading('Memuat katalog donghua...');
  let payload;
  try {
    const qs = new URLSearchParams();
    ['q', 'status', 'sort', 'page', 'limit'].forEach((k) => {
      if (params[k]) qs.set(k, params[k]);
    });
    payload = await api('/api/donghua?' + qs.toString());
  } catch (err) {
    view.innerHTML = errorBlock(err, 'Coba lagi');
    document.getElementById('retry-btn').onclick = () => renderDonghuaList(params);
    return;
  }
  const rows = payload.data || [];
  const meta = payload.meta || {};
  const fetched = meta.fetchedAt ? fmtDate(meta.fetchedAt) : null;

  view.innerHTML = `<div class="section-head">
      <h1>Donghua</h1>
      <p>${meta.total ? meta.total + ' judul animasi Tiongkok' : 'Katalog donghua'}${fetched ? ' · data ' + esc(fetched) : ''}</p>
    </div>
    <div class="notice">
      Donghua diputar di platform resmi pemegang lisensi (Bilibili/Bstation, iQIYI, WeTV, Youku, Muse Indonesia). Setiap judul menampilkan tautan resminya.
    </div>
    <form class="toolbar" id="donghua-form">
      <div class="field" style="flex:1 1 240px">
        <label for="d-q">Judul</label>
        <input id="d-q" name="q" type="search" value="${esc(params.q || '')}" placeholder="Cari donghua, misalnya link click">
      </div>
      <div class="field">
        <label for="d-status">Status</label>
        <select id="d-status" name="status">
          <option value="">Semua status</option>
          <option value="ongoing" ${params.status === 'ongoing' ? 'selected' : ''}>Ongoing</option>
          <option value="completed" ${params.status === 'completed' ? 'selected' : ''}>Selesai</option>
        </select>
      </div>
      <div class="field">
        <label for="d-sort">Urutkan</label>
        <select id="d-sort" name="sort">
          <option value="popular" ${!params.sort || params.sort === 'popular' ? 'selected' : ''}>Terpopuler</option>
          <option value="score" ${params.sort === 'score' ? 'selected' : ''}>Skor tertinggi</option>
          <option value="newest" ${params.sort === 'newest' ? 'selected' : ''}>Tahun terbaru</option>
          <option value="episodes" ${params.sort === 'episodes' ? 'selected' : ''}>Episode terbanyak</option>
          <option value="title" ${params.sort === 'title' ? 'selected' : ''}>Judul A-Z</option>
        </select>
      </div>
      <button class="btn btn-primary" type="submit">Terapkan</button>
    </form>
    ${rows.length ? `<div class="grid">${rows.map(donghuaCard).join('')}</div>` : '<div class="empty">Tidak ada donghua yang cocok.</div>'}
    ${pager(meta)}`;

  const form = document.getElementById('donghua-form');
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const data = new FormData(form);
    const qs = new URLSearchParams();
    for (const [k, v] of data.entries()) if (v && v !== 'popular') qs.set(k, v);
    navigate('/donghua' + (qs.toString() ? '?' + qs.toString() : ''));
  });
  form.querySelectorAll('select').forEach((sel) => sel.addEventListener('change', () => form.requestSubmit()));

  const pagerEl = view.querySelector('.pager');
  if (pagerEl) {
    pagerEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-page]');
      if (!btn || btn.disabled) return;
      const next = new URLSearchParams(params);
      next.set('page', btn.dataset.page);
      navigate('/donghua?' + next.toString());
      window.scrollTo({ top: 0 });
    });
  }
}

async function renderDonghuaDetail(id) {
  setActiveNav('donghua');
  loading('Memuat detail donghua...');
  let item;
  try {
    item = (await api('/api/donghua/' + encodeURIComponent(id))).data;
  } catch (err) {
    view.innerHTML = errorBlock(err, 'Coba lagi');
    document.getElementById('retry-btn').onclick = () => renderDonghuaDetail(id);
    return;
  }

  view.innerHTML = `<div class="detail-head">
      <div class="detail-poster">
        ${item.poster_url ? `<img src="${esc(item.poster_url)}" alt="Poster ${esc(item.title)}" width="440" height="660">` : ''}
      </div>
      <div>
        <h1 class="detail-title">${esc(item.title)}</h1>
        ${item.title_romaji && item.title_romaji !== item.title ? `<p class="detail-alt">${esc(item.title_romaji)}</p>` : ''}
        ${item.title_native ? `<p class="detail-alt small">${esc(item.title_native)}</p>` : ''}
        <div class="meta-row">
          ${item.status === 'ongoing' ? '<span class="tag live">Ongoing</span>' : `<span class="tag">${esc(item.status === 'completed' ? 'Selesai' : item.status || 'Tidak diketahui')}</span>`}
          ${item.score ? `<span class="tag score">★ ${fmtScore(item.score)}</span>` : ''}
          ${item.format ? `<span class="tag">${esc(item.format)}</span>` : ''}
          ${item.release_year ? `<span class="tag">${esc(item.release_year)}</span>` : ''}
          ${item.episodes ? `<span class="tag">${esc(item.episodes)} episode</span>` : '<span class="tag">Episode belum diumumkan</span>'}
          ${item.duration ? `<span class="tag">${esc(item.duration)} menit/episode</span>` : ''}
        </div>
        <div class="meta-row">
          ${(item.genres || []).map((g) => `<span class="tag">${esc(g)}</span>`).join('')}
        </div>
        ${item.next_airing_at ? `<div class="countdown"><span>Episode berikutnya</span><strong>${esc(daysUntil(item.next_airing_at) || '')} <span class="muted">(Episode ${esc(item.next_airing_episode || '?')})</span></strong></div>` : ''}
        <p class="synopsis">${esc(item.synopsis || 'Sinopsis belum tersedia dalam bahasa Inggris pada sumber data.')}</p>
        <div class="hero-actions">
          ${bookmarkButtonHtml('donghua', item.id)}
        </div>
      </div>
    </div>

    <section>
      <div class="section-head">
        <h2>Tonton di platform resmi</h2>
        <p>Sub Indo tersedia di sebagian platform; gunakan tautan resmi di bawah.</p>
      </div>
      ${
        (item.links || []).length
          ? `<div class="link-list">${item.links
              .map((l) => `<a class="link-card" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)} <span class="ext">buka</span></a>`)
              .join('')}</div>`
          : '<div class="notice warn">Platform resmi untuk judul ini belum terdaftar di sumber data. Cari judulnya langsung di Bilibili, iQIYI, atau WeTV.</div>'
      }
      <p class="small muted" style="margin-top:14px">Sumber metadata: <a href="${esc(item.source_url)}" target="_blank" rel="noopener noreferrer">AniList #${esc(item.id)}</a></p>
    </section>`;

  bindBookmarkButton({
    kind: 'donghua',
    id: item.id,
    title: item.title,
    posterUrl: item.poster_url || '',
    score: item.score || null,
    status: item.status || null,
    releaseYear: item.release_year || null,
    episodesCount: item.episodes || null,
  });
}

/* ---------------- koleksi (favorit & riwayat) ---------------- */
function renderCollection(params, defaultTab = 'favorit') {
  setActiveNav('koleksi');
  const activeTab = params.tab === 'riwayat' || defaultTab === 'riwayat' ? (params.tab === 'favorit' ? 'favorit' : 'riwayat') : 'favorit';
  const kindFilter = params.jenis === 'anime' || params.jenis === 'donghua' ? params.jenis : 'semua';
  let confirmClear = false;

  function paint() {
    const bookmarks = getBookmarks();
    const history = getHistory();
    document.title = (activeTab === 'riwayat' ? 'Riwayat tonton' : 'Favorit') + ' - Anime Nusantara';

    let bodyHtml = '';
    if (activeTab === 'favorit') {
      const filtered = kindFilter === 'semua' ? bookmarks : bookmarks.filter((b) => b.kind === kindFilter);
      const animeCount = bookmarks.filter((b) => b.kind === 'anime').length;
      const donghuaCount = bookmarks.filter((b) => b.kind === 'donghua').length;

      bodyHtml = `
        <div class="chips" role="group" aria-label="Filter jenis favorit">
          <a class="chip ${kindFilter === 'semua' ? 'active' : ''}" href="/koleksi?tab=favorit" data-link>Semua (${bookmarks.length})</a>
          <a class="chip ${kindFilter === 'anime' ? 'active' : ''}" href="/koleksi?tab=favorit&jenis=anime" data-link>Anime (${animeCount})</a>
          <a class="chip ${kindFilter === 'donghua' ? 'active' : ''}" href="/koleksi?tab=favorit&jenis=donghua" data-link>Donghua (${donghuaCount})</a>
        </div>
        ${
          filtered.length
            ? `<div class="grid">${filtered
                .map((b) => {
                  const href = b.kind === 'donghua' ? `/donghua/${esc(b.id)}` : `/anime/${esc(b.id)}`;
                  const kindTag = b.kind === 'donghua' ? '<span class="card-badge ep">Donghua</span>' : b.episodesCount ? `<span class="card-badge ep">${esc(b.episodesCount)} eps</span>` : '';
                  const statusBadge = b.status === 'ongoing' ? '<span class="card-badge" style="top:auto;bottom:6px">Ongoing</span>' : '';
                  const poster = b.posterUrl
                    ? `<img src="${esc(b.posterUrl)}" alt="Poster ${esc(b.title)}" loading="lazy" width="300" height="450">`
                    : '';
                  const sub = [b.score ? '★ ' + fmtScore(b.score) : null, b.releaseYear || null, b.kind === 'donghua' ? 'Donghua' : 'Anime']
                    .filter(Boolean)
                    .join(' · ');
                  return `<article class="card card-actions-wrap">
                    <button class="card-remove" type="button" data-remove-fav="${esc(b.id)}" data-remove-kind="${esc(b.kind)}" title="Hapus dari favorit" aria-label="Hapus ${esc(b.title)} dari favorit">&times;</button>
                    <a class="card-link" href="${href}" data-link>
                      <div class="card-poster">${poster}${kindTag}${statusBadge}</div>
                      <h3 class="card-title">${esc(b.title)}</h3>
                      <p class="card-sub">${esc(sub)}</p>
                    </a>
                  </article>`;
                })
                .join('')}</div>`
            : `<div class="empty">
                <p>Belum ada judul di daftar favorit${kindFilter !== 'semua' ? ' untuk kategori ini' : ''}.</p>
                <p class="small">Buka halaman detail anime atau donghua lalu tekan tombol <strong>Simpan ke favorit</strong>.</p>
                <p style="margin-top:14px"><a class="btn btn-primary" href="/anime" data-link>Jelajahi katalog</a></p>
              </div>`
        }`;
    } else {
      bodyHtml = `
        ${
          history.length
            ? `<div class="section-head">
                <p>${history.length} judul terakhir ditonton (tersimpan di browser ini)</p>
                <div class="hero-actions">
                  ${
                    confirmClear
                      ? `<button class="btn btn-danger-ghost" type="button" id="confirm-clear-history">Ya, hapus semua</button>
                         <button class="btn" type="button" id="cancel-clear-history">Batal</button>`
                      : `<button class="btn btn-danger-ghost" type="button" id="clear-history-btn">Hapus semua riwayat</button>`
                  }
                </div>
              </div>
              <div class="history-list">
                ${history
                  .map((item) => {
                    const pct = calcProgressPct(item);
                    const epText = item.episodeNumber != null ? `Episode ${item.episodeNumber}` : item.episodeLabel || '';
                    const progText = item.completed
                      ? 'Selesai ditonton'
                      : item.position > 0
                      ? formatTime(item.position) + (item.duration > 0 ? ' / ' + formatTime(item.duration) : '')
                      : 'Baru dimulai';
                    const whenText = fmtRelativeTime(item.updatedAt);
                    const meta = [epText, progText, whenText].filter(Boolean).join(' · ');
                    return `<article class="history-item">
                      <a class="history-thumb" href="/nonton/${esc(item.episodeSlug)}" data-link aria-label="Tonton ${esc(item.title)}">
                        ${item.posterUrl ? `<img src="${esc(item.posterUrl)}" alt="" loading="lazy">` : ''}
                      </a>
                      <div class="history-info">
                        <a class="history-title" href="/anime/${esc(item.animeSlug)}" data-link>${esc(item.title)}</a>
                        <div class="history-meta">${esc(meta)}</div>
                        ${pct > 0 ? `<div class="history-bar" aria-hidden="true"><span style="width:${pct}%"></span></div>` : ''}
                      </div>
                      <div class="history-actions">
                        <a class="btn btn-primary" href="/nonton/${esc(item.episodeSlug)}" data-link>${item.completed ? 'Tonton ulang' : 'Lanjutkan'}</a>
                        <button class="btn btn-ghost" type="button" data-remove-hist="${esc(item.animeSlug)}" aria-label="Hapus ${esc(item.title)} dari riwayat">Hapus</button>
                      </div>
                    </article>`;
                  })
                  .join('')}
              </div>`
            : `<div class="empty">
                <p>Riwayat tontonan masih kosong.</p>
                <p class="small">Episode yang kamu putar akan muncul di sini supaya mudah dilanjutkan.</p>
                <p style="margin-top:14px"><a class="btn btn-primary" href="/" data-link>Lihat rilis terbaru</a></p>
              </div>`
        }`;
    }

    view.innerHTML = `<div class="section-head">
        <h1>Koleksi saya</h1>
        <p>Tersimpan lokal di perangkat ini tanpa perlu akun</p>
      </div>
      <div class="tabs" role="tablist" aria-label="Bagian koleksi">
        <a class="tab" role="tab" href="/koleksi?tab=favorit" data-link aria-selected="${activeTab === 'favorit' ? 'true' : 'false'}">
          Favorit <span class="tab-count">${bookmarks.length}</span>
        </a>
        <a class="tab" role="tab" href="/koleksi?tab=riwayat" data-link aria-selected="${activeTab === 'riwayat' ? 'true' : 'false'}">
          Riwayat tonton <span class="tab-count">${history.length}</span>
        </a>
      </div>
      ${bodyHtml}`;

    const clearBtn = document.getElementById('clear-history-btn');
    if (clearBtn) {
      clearBtn.onclick = () => {
        confirmClear = true;
        paint();
      };
    }
    const confirmBtn = document.getElementById('confirm-clear-history');
    if (confirmBtn) {
      confirmBtn.onclick = () => {
        clearHistory();
        confirmClear = false;
        paint();
      };
    }
    const cancelBtn = document.getElementById('cancel-clear-history');
    if (cancelBtn) {
      cancelBtn.onclick = () => {
        confirmClear = false;
        paint();
      };
    }
  }

  view.onclick = (ev) => {
    const favBtn = ev.target.closest('button[data-remove-fav]');
    if (favBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      removeBookmark(favBtn.dataset.removeKind, favBtn.dataset.removeFav);
      paint();
      return;
    }
    const histBtn = ev.target.closest('button[data-remove-hist]');
    if (histBtn) {
      ev.preventDefault();
      removeHistoryItem(histBtn.dataset.removeHist);
      paint();
    }
  };

  paint();
}

/* ---------------- jadwal ---------------- */
async function renderSchedule() {
  setActiveNav('jadwal');
  loading('Memuat jadwal rilis...');
  let payload;
  try {
    payload = await api('/api/schedule');
  } catch (err) {
    view.innerHTML = errorBlock(err, 'Coba lagi');
    document.getElementById('retry-btn').onclick = () => renderSchedule();
    return;
  }
  const days = payload.data || [];
  const upcoming = days.filter((d) => !d.is_past).length;
  view.innerHTML = `<div class="section-head">
      <h1>Jadwal rilis</h1>
      <p>${upcoming} hari ke depan · ${days.length} hari tercatat · jam tayang mengikuti waktu Jepang</p>
    </div>
    ${days
      .map(
        (day) => `<div class="day-block${day.is_past ? ' day-past' : ''}">
          <div class="day-head">
            <h3>${esc(day.label || day.day)}${day.is_today ? ' <span class="tag live">Hari ini</span>' : ''}${
          day.is_past ? ' <span class="tag">Sudah tayang</span>' : ''
        }</h3>
            <span class="small muted">${esc(fmtDate(day.date) || day.date || 'Belum ada tanggal')} · ${(day.anime || []).length} judul</span>
          </div>
          <div class="day-list">
            ${(day.anime || [])
              .map(
                (a) => `<a class="day-item" href="/anime/${esc(a.slug)}" data-link>
                  ${a.poster_url ? `<img src="${esc(a.poster_url)}" alt="" aria-hidden="true" loading="lazy">` : ''}
                  <span>
                    <span class="t">${esc(a.title)}</span><br>
                    <span class="s">${a.latest_episode ? 'Episode terakhir ' + esc(a.latest_episode) : 'Jadwal baru'}${a.score ? ' · ★ ' + fmtScore(a.score) : ''}</span>
                  </span>
                </a>`
              )
              .join('')}
          </div>
        </div>`
      )
      .join('')}`;
}

/* ---------------- status footer ---------------- */
async function updateFooterStatus() {
  const el = document.getElementById('footer-status');
  if (!el) return;
  try {
    const res = await api('/api/status');
    const d = res.data;
    const parts = [];
    parts.push(`${d.catalog.total.toLocaleString('id-ID')} anime`);
    parts.push(`${(d.catalog.ongoing != null ? d.catalog.ongoing : d.home.ongoing) || 0} ongoing`);
    parts.push(`${d.donghua.total} donghua`);
    if (d.craftvel.quota) parts.push(`kuota video ${d.craftvel.quota.remaining}/${d.craftvel.quota.limit}`);
    if (d.home.generatedAt) parts.push(`data ${new Date(d.home.generatedAt).toLocaleTimeString('id-ID')}`);
    el.textContent = parts.join(' · ');
  } catch (err) {
    el.textContent = 'Status server tidak tersedia';
  }
}

/* ---------------- router ---------------- */
async function render() {
  const url = new URL(window.location.href);
  const path = url.pathname;
  const params = Object.fromEntries(url.searchParams.entries());

  view.onclick = null;
  if (currentPlayer) {
    currentPlayer = null;
  }
  document.title = 'Anime Nusantara - Anime Sub Indo & Donghua';

  try {
    if (path === '/' || path === '') await renderHome();
    else if (path === '/anime') await renderCatalog(params);
    else if (path === '/ongoing') await renderOngoing(params);
    else if (path === '/donghua') await renderDonghuaList(params);
    else if (path === '/jadwal') await renderSchedule();
    else if (path === '/koleksi') renderCollection(params, 'favorit');
    else if (path === '/favorit') renderCollection(params, 'favorit');
    else if (path === '/riwayat') renderCollection(params, 'riwayat');
    else {
      let m = path.match(/^\/anime\/([\w.-]+)$/);
      if (m) await renderDetail(decodeURIComponent(m[1]));
      else {
        m = path.match(/^\/nonton\/([\w.-]+)$/);
        if (m) await renderPlayer(decodeURIComponent(m[1]));
        else {
          m = path.match(/^\/donghua\/([\w.-]+)$/);
          if (m) await renderDonghuaDetail(decodeURIComponent(m[1]));
          else
            view.innerHTML = `<div class="empty"><h1 style="margin-top:0">Halaman tidak ditemukan</h1>
      <p><a href="/" data-link>Kembali ke beranda</a></p></div>`;
        }
      }
    }
  } catch (err) {
    console.error(err);
    view.innerHTML = errorBlock(err, null);
  }
  updateFooterStatus();
}

render();
setInterval(updateFooterStatus, 60000);
