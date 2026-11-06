# B2B Lead Generation & Automated Outreach Platform

> **Solusi All-in-One Penemuan Prospek B2B, Ekstraksi Kontak Cerdas, Penilaian Kelayakan Berbasis AI, dan Sistem Cold Email Outreach Bertahap.**

---

## 📌 Ringkasan Produk

Platform siap pakai (*production-ready*) berbasis arsitektur **Vercel Serverless** dan **Upstash Redis** yang dirancang untuk mengotomatiskan proses akuisisi prospek bisnis B2B. Sistem ini menggabungkan pencarian lokasi presisi (Google Maps & OpenStreetMap), ekstraksi kontak situs web (email & WhatsApp), algoritma penilaian prospek cerdas (*Scoring Engine*), serta pengiriman email penawaran bertahap dengan pelacakan konversi dan kepatuhan anti-spam internasional.

---

## 🚀 Fitur Unggulan

- **Multi-Source Lead Discovery**: Pencarian tempat dan direktori bisnis di kota mana pun melalui integrasi Google Maps (SerpApi) dan OpenStreetMap (Overpass & Photon).
- **Automated Contact Extraction**: Mesin ekstraksi otomatis yang menelusuri situs web bisnis untuk menemukan alamat email dan nomor WhatsApp aktif.
- **Intelligent Lead Scoring Engine**:
  - Penilaian kelayakan otomatis (0–100) menggunakan aturan parameter terukur (*rule-based*).
  - Integrasi **Google Gemini AI** untuk analisis mendalam, perangkuman profil, dan copywriting draf email penawaran.
- **Multi-Step Email Outreach & Follow-Up**:
  - Pengiriman pesan bertahap terotomasi via **Resend**.
  - Siklus follow-up berkala yang otomatis berhenti saat prospek merespons.
  - Pengujian variasi pesan (**A/B/C Testing**) dilengkapi analisis signifikansi statistik (*z-test*).
- **Stealth Gateway & Enterprise Security**:
  - Antarmuka login tersembunyi di balik parameter `LOGIN_PATH` yang menyajikan status HTTP 404 asli bagi publik.
  - Sesi berbasis HTTP-Only cookie bertanda tangan digital (HMAC SHA-256).
  - Proteksi *brute-force* login berbasis IP throttling di Redis.
  - Seluruh kunci API disimpan terenkripsi secara simetris di server.
- **Kepatuhan Anti-Spam (CAN-SPAM & GDPR Compliant)**:
  - Tautan *Unsubscribe* bertanda tangan digital dengan verifikasi satu klik.
  - Header standar RFC 8058 `List-Unsubscribe`.
  - Penanganan otomatis kasus hard bounce dan laporan spam via webhook Resend.
  - **Circuit Breaker**: Penghentian darurat otomatis saat rasio bounce melebihi ambang batas aman.
- **Multi-Akun SerpApi & Failover Otomatis**:
  - Pemantauan sisa kuota API secara real-time tanpa mengurangi kuota.
  - Pengalihan otomatis (*failover*) ke akun cadangan saat kuota akun aktif menipis.
- **Dasbor Analitik Komprehensif**:
  - Pemantauan corong konversi prospek (*funnel analysis*).
  - Distribusi geografis performa prospek berdasarkan negara dan kota.
  - Grafik tren aktivitas historis 7, 14, 30, dan 90 hari.

---

## 📋 Prasyarat Sistem

1. Akun **Vercel** (Dapat menggunakan paket Hobby gratis).
2. Akun **Upstash Redis** (Kompatibel dengan paket serverless gratis).
3. Akun **Resend** dengan domain pengirim yang telah terverifikasi DNS.
4. API Key **SerpApi** (untuk sumber Google Maps).
5. API Key **Google Gemini** (Gratis via Google AI Studio).

---

## ⚙️ Panduan Instalasi & Deployment

### 1. Hubungkan Basis Data Upstash Redis
1. Buka proyek Anda di dashboard Vercel.
2. Buka tab **Storage** > klik **Connect Store** > pilih **Upstash Redis**.
3. Variabel `UPSTASH_REDIS_REST_URL` dan `UPSTASH_REDIS_REST_TOKEN` akan dikonfigurasi secara otomatis.

### 2. Konfigurasi Environment Variables
Buka **Project Settings** > **Environment Variables**, dan tambahkan variabel berikut:

| Variabel | Kategori | Deskripsi |
| :--- | :--- | :--- |
| `APP_PASSWORD` | **Wajib** | Kata sandi master untuk masuk ke portal aplikasi. |
| `LOGIN_PATH` | **Wajib** | Path URL rahasia login (contoh: `portal-auth-x9`). |
| `CRON_SECRET` | *Direkomendasikan* | Token pengaman endpoint Vercel Cron. |
| `RESEND_WEBHOOK_SECRET` | *Direkomendasikan* | Kunci verifikasi webhook Resend (`whsec_...`). |
| `UNSUB_SECRET` | *Direkomendasikan* | Kunci HMAC penandatanganan tautan unsubscribe. |
| `PUBLIC_URL` | *Opsional* | Domain produksi (contoh: `https://outreach.domainanda.com`). |
| `RESEND_DAILY_LIMIT` | *Opsional* | Batas kuota email per hari (default: `100`). |

> **Catatan Keamanan:** Pastikan memilih opsi *Production*, *Preview*, dan *Development* saat menyimpan variabel, lalu lakukan **Redeploy**.

### 3. Akses Portal & Konfigurasi API Key
1. Buka browser dan navigasikan ke: `https://domainanda.com/<LOGIN_PATH>`
2. Masukkan kata sandi yang telah Anda atur pada `APP_PASSWORD`.
3. Klik menu **Pengaturan** di pojok kiri bawah untuk memasukkan API Key:
   - SerpApi Key 1 (dan Key 2 sebagai cadangan)
   - Resend API Key & Email Pengirim
   - Google Gemini API Key
   - Geoapify Key (opsional)

---

## 🗂️ Struktur Direktori Proyek

```text
├── api/
│   ├── _404.html         # Halaman stealth 404 multi-bahasa
│   ├── _app.html         # Single Page Application frontend (HTML5/CSS3/Vanilla JS)
│   ├── _auth.js          # Utilitas otentikasi sesi HMAC & cookie security
│   ├── _clean.js         # Modul pemeliharaan dan pembersihan data berkala
│   ├── _contacts.js      # Pembersihan dan validasi format kontak
│   ├── _jobs.js          # Mesin eksekusi siklus otomasi sistem
│   ├── _leads.js         # Algoritma deduplikasi dan sanitasi prospek
│   ├── _mail.js          # Gateway email Resend, template HTML responsif, & DNS MX check
│   ├── _score.js         # Algoritma scoring prospek rule-based
│   ├── _serp.js          # Konektor SerpApi & failover multi-akun
│   ├── _store.js         # Abstraksi koneksi REST Upstash Redis & enkripsi simetris
│   ├── _template.js      # Template cold outreach awal & metadata brand
│   ├── ai.js             # Endpoint evaluasi & copywriting Google Gemini AI
│   ├── app.js            # Gateway otentikasi & proteksi akses route
│   ├── auto.js           # Endpoint otomasi, antrean, & handler cron
│   ├── dash.js           # Endpoint analitik dasbor & A/B testing
│   ├── keys.js           # Endpoint manajemen API Key terenkripsi
│   ├── leads.js          # Endpoint manajemen data dan status prospek
│   ├── mailhook.js       # Endpoint webhook Resend & portal unsubscribe
│   ├── places.js         # Endpoint pencarian prospek Google Maps & OSM
│   ├── send.js           # Endpoint pemrosesan pengiriman cold email
│   ├── session.js        # Endpoint otentikasi masuk/keluar & rate limiting
│   └── usage.js          # Endpoint pemantauan kuota & ekstraksi web kontak
├── vercel.json           # Konfigurasi routing serverless & jadwal cron
├── README.txt            # Dokumentasi teknis versi teks murni
└── README.md             # Dokumentasi teknis format Markdown
```

---

## 🔒 Standar Keamanan & Reputasi Pengirim

Sistem ini dirancang khusus untuk meminimalkan risiko masuk ke folder spam:
1. **Sapaan Personal Otomatis**: Menghindari kesan email massal dengan menyematkan nama bisnis secara kontekstual.
2. **Validasi DNS MX**: Memeriksa keberadaan mail server penerima sebelum email dimasukkan ke antrean.
3. **Pemberhentian Siklus Instan**: Begitu calon pembeli membalas email atau statusnya diperbarui, urutan follow-up otomatis dihentikan.
4. **Proteksi Circuit Breaker**: Jika terjadi lonjakan bounce rate di atas 4%, pengiriman otomatis dijeda seketika demi menjaga reputasi domain.

---

## 📄 Lisensi & Hak Penggunaan

Source code ini bersifat komersial. Anda memiliki hak penuh untuk memodifikasi, menggunakan pada proyek internal, maupun mengkustomisasi fitur sesuai kebutuhan bisnis Anda.
