# Desain: Anime Nusantara (katalog anime sub Indo + donghua)

Tanggal: 19 November 2026
Status: disetujui pemilik proyek ("lanjut"), sudah diimplementasikan dan diverifikasi.

## Maksud

Satu situs lokal untuk melihat katalog anime sub Indo selengkap mungkin, membuka daftar episode tiap judul, memutar episodenya tanpa iklan, dan melihat judul ongoing ikut terbarui sendiri. Donghua (animasi Tiongkok) juga harus ada, dengan tautan ke platform resminya.

## Tujuan

- Indeks seluruh katalog sumber (1.936 judul, 27.791 episode) bisa dicari, difilter genre/status, dan diurutkan.
- Halaman detail menampilkan seluruh episode (bukan potongan), termasuk anime panjang.
- Pemutar memutar MP4 langsung, tanpa iframe dan tanpa script pihak ketiga.
- Judul ongoing punya daftar episode dan countdown yang ikut bergerak tanpa perlu deploy ulang.
- Donghua 400 judul terpopuler lengkap dengan tautan platform resmi.

## Bukan tujuan

- Tidak menyimpan atau menyalin berkas video. Pemutar memakai tautan dari API berlisensi.
- Tidak menyediakan stream donghua ilegal; donghua diarahkan ke platform resmi.
- Tidak ada akun pengguna, komentar, atau unggahan.

## Batasan nyata

- Paket API `solo`: 100 resolusi episode per bulan, kualitas maksimum 720p, ~2 request/detik.
- Provider "Primary" sedang down saat pengembangan; "Mirror-1" hidup. Pemutar harus fallback.
- Katalog sumber tidak memuat donghua sama sekali (pencarian doupo/soul land/perfect world = 0 hasil), dan tidak memuat beberapa judul panjang klasik (One Piece, Conan, Doraemon).

## Pendekatan yang dipertimbangkan

1. **A. Donghua via metadata AniList + tautan resmi** (dipilih). Katalog donghua lengkap dan bisa ditelusuri; pemutaran terjadi di platform pemegang lisensi, jadi tidak ada risiko player mati atau tautan bajakan.
2. **B. Hanya anime, donghua diabaikan.** Paling sederhana dan 100% pemutar lokal, tetapi permintaan donghua tidak terpenuhi.
3. **C. Agregator stream donghua pihak ketiga.** Ditolak: menyalin stream tanpa lisensi, rawan mati, dan berisiko hukum.

## Keputusan implementasi

- Node.js murni tanpa dependensi; SPA vanilla; cache JSON di `data/`.
- Indeks katalog dibangun sekali dari `completed` (38 halaman x 50) + `ongoing` + `popular`, disimpan bertahap supaya bisa dilanjutkan.
- Pencarian lokal dengan skor relevansi berbatas kata (bukan substring bebas) agar hasil tidak melenceng.
- Pacing 620 ms antar request ke API katalog; retry untuk 429/5xx.
- Tautan video di-cache dan divalidasi dengan range request sebelum dipakai ulang; umur cache mengikuti `expires_at` dari API.
- Resolusi stream: tanpa parameter dulu (auto pilih server sehat), lalu nama server yang dikenal, lalu `primary`.
- Pemutar memakai relay lokal `/api/video/:episode?q=<kualitas>` yang meneruskan Range request. Media host mengirim `Alt-Svc: h3` dan sebagian klien berhenti di `readyState 0` saat memilih QUIC; relay menghilangkan variabel itu sekaligus menyembunyikan URL asli.
- Donghua: 8 halaman AniList x 50, dedupe tautan per label platform.
- Kuota API ditampilkan di footer dan halaman pemutar supaya batasnya terlihat, bukan disembunyikan.

## Bukti verifikasi

- `/api/stream/jjkn-sub-indo-episode-1` → HTTP 200, satu sumber `720p · CDN`.
- Range request ke tautan media → `206 Partial Content`, `Content-Type: video/mp4`, isi diawali `ftypisom` (H.264).
- Di browser: `video.readyState = 4`, `currentTime` maju ke 2,7 detik setelah `play()` (muted), tanpa overlay error.
- Tidak ada `iframe`, tidak ada `script[src]` pihak ketiga.
- `/api/anime/borot-sub-indo/episodes` → 293 episode, nomor 1..293 unik.
- Indeks katalog: 1.905 judul, 21 ongoing.
- Donghua: 400 judul, 371 punya tautan resmi.
- Mobile 375x812: `scrollWidth = 375` (tanpa overflow), target sentuh nav 44 px.
