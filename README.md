# Anime Nusantara

Katalog anime sub Indo + donghua, dengan pemutar video, daftar episode lengkap, jadwal rilis, dan pembaruan ongoing otomatis. Node.js murni, tanpa dependensi npm.

## Menjalankan

```bash
cd "D:/DIKA/web anime 2"
node server.js
```

Buka http://127.0.0.1:3000

Kunci API dibaca dari environment `CRAFTVEL_API_KEY`, atau dari berkas `.env` di folder proyek:

```
CRAFTVEL_API_KEY=isi_kunci_anda
PORT=3000
```

## Apa yang ada di dalamnya

- Indeks lokal 1.900+ anime sub Indo (dibangun sekali, lalu diperbarui otomatis).
- Daftar episode lengkap per judul, termasuk anime panjang (diuji 293 episode Boruto, halaman demi halaman).
- Pemutar MP4 dengan pemilihan kualitas, lanjut dari posisi terakhir, episode sebelumnya/berikutnya, dan tombol coba lagi saat server video bermasalah.
- Beranda berisi rilis terbaru, sedang tayang, populer, dan tautan jelajah.
- Jadwal rilis 7 hari.
- Katalog donghua 400 judul dari AniList dengan tautan platform resmi (Bilibili/Bstation, iQIYI, WeTV, Youku, Netflix, Crunchyroll, Muse, Amazon Prime).
- Pencarian dengan peringkat relevansi, filter genre dan status.

## Pembaruan otomatis

| Lapisan | Interval | Berkas cache |
| --- | --- | --- |
| Beranda, ongoing, jadwal | 5 menit | `data/home.json` |
| Episode judul ongoing (5 judul per putaran) | 3 menit | `data/episodes/*.json` |
| Katalog donghua | 12 jam | `data/donghua.json` |
| Indeks katalog penuh | saat boot bila kosong | `data/catalog.json` |

## Catatan kuota

Paket Craftvel `solo` membatasi 100 resolusi episode per bulan. Pemutar memakai cache: episode yang sudah pernah dibuka tidak memakai kuota lagi sampai tautannya kedaluwarsa (`expires_at` dari API). Sisa kuota ditampilkan di footer dan di halaman pemutar.

## Endpoint

- `GET /api/status` ringkasan katalog, kuota, cache
- `GET /api/home` rilis terbaru, ongoing, jadwal
- `GET /api/anime?q=&genre=&status=&sort=&page=` katalog
- `GET /api/anime/:slug` detail + seluruh episode
- `GET /api/anime/:slug/episodes` daftar episode (bisa `?refresh=1`)
- `GET /api/stream/:episode` tautan video (bisa `?refresh=1`)
- `GET /api/video/:episode?q=720p` relay video dengan dukungan Range (dipakai pemutar)
- `GET /api/donghua?q=&status=&sort=&page=` katalog donghua
- `GET /api/donghua/:id` detail donghua + tautan resmi
- `GET /api/schedule` jadwal 7 hari
- `GET /api/refresh?layer=home|episodes|donghua|catalog` paksa pembaruan

## Struktur

```
server.js          HTTP server + routing
lib/craftvel.js    klien API katalog (pacing 2 rps, retry 429/5xx)
lib/catalog.js     indeks lokal + pencarian
lib/episodes.js    cache daftar episode per anime
lib/streams.js     cache tautan video + verifikasi tautan mati
lib/anilist.js     katalog donghua + tautan platform resmi
lib/scheduler.js   penjadwal pembaruan
public/            SPA (index.html, app.js, style.css)
data/              cache JSON (dibuat otomatis)
```
