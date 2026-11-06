================================================================================
B2B LEAD GENERATION & AUTOMATED OUTREACH PLATFORM - DOKUMENTASI TEKNIS & PANDUAN
================================================================================

Platform pencarian prospek bisnis B2B (salon, toko wig, toko kecantikan, dan distributor) 
berbasis Google Maps dan OpenStreetMap, terintegrasi dengan mesin ekstraksi kontak otomatis 
(email & WhatsApp), penilaian prospek cerdas (Scoring Engine AI & Rule-based), serta sistem 
cold email outreach otomatis bertahap dengan pelacakan konversi dan kepatuhan anti-spam.

Seluruh data transaksi dan status disimpan secara terpusat pada Upstash Redis 
dengan namespace awalan "hairleads:".

--------------------------------------------------------------------------------
DAFTAR ISI
--------------------------------------------------------------------------------
  1. Panduan Instalasi & Deployment
  2. Konfigurasi Variabel Lingkungan (Environment Variables)
  3. Arsitektur Menu & Navigasi
  4. Manajemen & Eksplorasi Prospek
  5. Pengiriman Email Outreach (Integrasi Resend)
  6. Mesin Otomasi (Pengiriman, Follow-Up, Rotasi Kota, Ekstraksi Kontak)
  7. Standar Keamanan & Kepatuhan Regulasi (Compliance)
  8. Laporan Operasional Harian, Notifikasi Sistem & Pemeliharaan Data
  9. Dasbor Analitik & Uji Variasi Pesan A/B
 10. Skema Struktur Data Redis
 11. Batasan Sistem & Rekomendasi Infrastruktur
 12. Struktur Direktori Proyek


--------------------------------------------------------------------------------
1. PANDUAN INSTALASI & DEPLOYMENT
--------------------------------------------------------------------------------
Langkah deployment sistem (sekali konfigurasi di Vercel):

1) Hubungkan Basis Data Redis:
   - Pada dashboard proyek Vercel, buka tab Storage > Connect Store > pilih Upstash Redis.
   - Variabel koneksi (UPSTASH_REDIS_REST_URL dan UPSTASH_REDIS_REST_TOKEN) akan 
     terisi secara otomatis ke dalam konfigurasi environment.

2) Konfigurasi Kredensial Keamanan:
   - Buka Project Settings > Environment Variables, tambahkan variabel berikut:
     * APP_PASSWORD : Kata sandi untuk otentikasi masuk ke portal sistem (gunakan kombinasi unik).
     * LOGIN_PATH   : Path URL rahasia untuk mengakses form login tanpa garis miring 
                      (contoh: portal-auth-x7q).
   - Pastikan mencentang opsi Production, Preview, dan Development.

3) Mekanisme Keamanan Stealth Gateway:
   - Akses aplikasi pertama kali melalui URL: https://domainanda.com/<LOGIN_PATH>
   - Seluruh request di luar path rahasia tersebut (termasuk root "/") secara default 
     akan menyajikan halaman 404 (api/_404.html) dengan kode status HTTP 404 asli. 
     Mekanisme ini dirancang untuk mencegah pemindaian pihak ketiga dan akses tanpa izin.
   - Setelah otentikasi berhasil, sesi disimpan melalui HTTP-Only cookie terenkripsi, 
     dan URL di browser akan secara otomatis kembali ke root ("/").
   - Parameter LOGIN_PATH dapat diubah sewaktu-waktu tanpa membatalkan sesi pengguna aktif.

4) Deploy & Inisialisasi Kunci API:
   - Buka tab Deployments > klik ikon tiga titik pada commit terbaru > pilih Redeploy.
   - Buka URL akses Anda, masuk menggunakan APP_PASSWORD, buka modal "Pengaturan", 
     dan masukkan API Key pihak ketiga:
     * SerpApi Key 1 (dan Akun 2 untuk failover cadangan)
     * Resend API Key & Email Pengirim
     * Google Gemini API Key (untuk fitur penilaian AI dan copywriting draf)
     * Geoapify API Key (opsional, untuk sumber OpenStreetMap)
   - Seluruh kunci API disimpan dalam bentuk terenkripsi pada Upstash Redis 
     (hairleads:keys) dan dapat digunakan secara terpusat di semua perangkat.


--------------------------------------------------------------------------------
2. KONFIGURASI VARIABEL LINGKUNGAN (ENVIRONMENT VARIABLES)
--------------------------------------------------------------------------------
Setiap pembaruan variabel lingkungan memerlukan proses Redeploy pada Vercel.

Variabel Wajib:
  APP_PASSWORD            Kata sandi otentikasi master untuk mengakses portal aplikasi.
  LOGIN_PATH              Path rahasia pintu masuk antarmuka login (mencegah akses publik).

Variabel Fitur Otomasi & Kepatuhan (Sangat Direkomendasikan):
  CRON_SECRET             Token acak panjang untuk mengamankan eksekusi endpoint 
                          Vercel Cron (/api/auto?a=cron). Vercel menyematkan token 
                          ini otomatis pada header Authorization: Bearer.
  RESEND_WEBHOOK_SECRET   Kunci rahasia dari menu Resend > Webhooks (whsec_...). 
                          Digunakan untuk memvalidasi integritas event bounce & spam.
  UNSUB_SECRET            Token acak panjang untuk tanda tangan digital HMAC tautan 
                          pembatalan langganan (Unsubscribe). Disimpan permanen agar 
                          tautan pada email yang telah terkirim tetap valid.
  PUBLIC_URL (opsional)   URL domain produksi (contoh: https://outreach.domainanda.com) 
                          untuk memastikan keakuratan tautan unsubscribe dan webhook.
  RESEND_DAILY_LIMIT      Batas kuota pengiriman harian (default: 100 untuk tier gratis 
                          Resend). Masukkan nilai 0 untuk kuota tanpa batas.


--------------------------------------------------------------------------------
3. ARSITEKTUR MENU & NAVIGASI
--------------------------------------------------------------------------------
Analisis
  Dasbor Utama             Analisis corong konversi prospek, performa uji variasi A/B, 
                           serta distribusi geografis per negara dan kota.
Manajemen Prospek
  Cari Tempat              Eksplorasi prospek bisnis via Google Maps & OpenStreetMap.
  Prospek Tersimpan        Koleksi prospek terverifikasi dan riwayat pencarian.
Penjangkauan (Outreach)
  Email Outreach           Pusat penyusunan dan pengiriman email penawaran cold outreach.
  WhatsApp Outreach        Daftar prospek dengan nomor WhatsApp terverifikasi.
  Riwayat Pengiriman       Log audit seluruh email yang telah diproses oleh sistem.
Otomasi Sistem
  Status & Antrean         Status operasional cron, eksekusi instan, dan antrean kurasi.
  Pengiriman Email         Konfigurasi jadwal pengiriman otomatis & manajemen template pesan.
  Otomasi Pencarian        Penyegaran pencarian berkala, rotasi multi-kota, & ekstraksi kontak.
  Pengaturan Sistem        Kriteria bobot skor kelayakan, laporan harian, pemeliharaan 
                           data, multi-akun SerpApi, dan daftar pengecualian.


--------------------------------------------------------------------------------
4. MANAJEMEN & EKSPLORASI PROSPEK
--------------------------------------------------------------------------------
- Caching Data Efisien:
  Hasil pencarian disimpan pada Redis (hairleads:cache). Pencarian ulang dengan 
  kombinasi kota, kategori, dan sumber yang sama akan langsung membaca memori cache 
  tanpa mengonsumsi kuota SerpApi. Tombol "Cari Prospek" memicu pengambilan data baru.
- Rasio Kuota:
  1 halaman Google Maps = 20 prospek bisnis = 1 kuota SerpApi.
- Algoritma Deduplikasi Cerdas:
  Sistem secara otomatis mendeteksi dan mengeliminasi entitas duplikat berdasarkan:
  place_id, kombinasi identik nama dan alamat, atau nomor telepon serupa dengan nama mirip.
  Entitas cabang dengan alamat berbeda tetap dipertahankan.
- Deduplikasi Lintas Wilayah (Cross-City):
  Tempat yang telah terdata pada pencarian kota lain tidak akan dicatat ganda pada 
  pencarian kota baru berikutnya.
- Status Prospek Terpadu:
  Status dan catatan prospek disimpan terpusat (hairleads:leads) sehingga konsisten di 
  seluruh modul:
  * Belum Dihubungi (default)
  * Sudah Dihubungi
  * Dibalas
  * Deal
  * Tidak Cocok


--------------------------------------------------------------------------------
5. PENGIRIMAN EMAIL OUTREACH (INTEGRASI RESEND)
--------------------------------------------------------------------------------
Prasyarat:
  1. Pada akun Resend: Daftarkan dan verifikasi domain pengirim (Domains > Add Domain, 
     lengkapi record DNS SPF dan DKIM).
  2. Buka menu Pengaturan pada aplikasi: Masukkan API Key Resend, Alamat Email Pengirim 
     (contoh: sales@domainanda.com), Alamat Reply-To, Alamat Fisik Bisnis, dan 
     Keterangan Sumber Kontak.

Metode Pengiriman:
  - Pengiriman Langsung (Per Entitas): Buka detail prospek > Kirim Email. Konten 
    dapat dipersonalisasi terlebih dahulu sebelum dikirim.
  - Pengiriman Batch Terkurasi: Tombol "Kirim Email" pada tab Email Outreach. 
    Hanya menargetkan prospek berstatus Belum Dihubungi yang memiliki email valid.
  - Pengiriman Uji Coba: Fitur pengiriman manual untuk verifikasi tampilan ke email internal.

Manajemen Reputasi & Pelacakan:
  - Setiap email yang terkirim otomatis memperbarui status prospek menjadi "Sudah Dihubungi" 
    dan mencatat timestamp pengiriman pada riwayat (hairleads:mail).
  - Penghitung kuota harian (hairleads:mailday) memantau batas volume pengiriman 
    secara real-time, reset setiap pukul 07.00 WIB (00:00 UTC).


--------------------------------------------------------------------------------
6. MESIN OTOMASI (PENGIRIMAN, FOLLOW-UP, ROTASI KOTA, EKSTRAKSI KONTAK)
--------------------------------------------------------------------------------
Arsitektur otomasi dirancang modular dan dieksekusi melalui endpoint /api/auto?a=cron 
yang dijadwalkan via Vercel Cron.

6.1 Penjadwalan:
  - vercel.json mengeksekusi cron setiap hari pukul 18:00 UTC / 01:00 WIB ("0 18 * * *").
  - Fitur "Jalankan Otomasi Sekarang" memungkinkan pemicuan seluruh tugas secara langsung 
    dengan batas waktu eksekusi hingga 60 detik.

6.2 Siklus Urutan Eksekusi:
  1. Pengiriman pesan follow-up jatuh tempo + email penawaran pertama yang disetujui.
  2. Penyegaran berkala terhadap pencarian tersimpan yang diaktifkan.
  3. Ekstraksi otomatis email dan WhatsApp dari situs web prospek baru.
  4. Pengisian antrean persetujuan berdasarkan evaluasi skor kelayakan prospek.
  5. Pemeliharaan dan pembersihan data usang di akhir siklus.

6.3 Scoring Engine Kelayakan Prospek (0–100):
  Sistem mengevaluasi prospek berdasarkan parameter rule-based (api/_score.js):
  Penambah Skor (+):
    - Kepemilikan Email: +30 (+5 jika domain perusahaan kustom)
    - Kepemilikan Website: +10
    - Kepemilikan WhatsApp / Telepon: +5 masing-masing
    - Rating Bisnis Tinggi: 4.5+ (+10) / 4.0+ (+6)
    - Volume Ulasan Tinggi: 100+ (+10) / 30+ (+7) / 10+ (+4)
    - Kata Kunci Niche Relevan pada Nama Bisnis: +15
  Pengurang Skor / Sinyal Negatif (-):
    - Jaringan Korporasi / Ritel Masif (Sally Beauty, Ulta, Walmart, dll.): -50
    - Non-Kategori Relevan (Klinik, Salon Kuku, Tato, Spa, Sekolah): -15
    - Alamat Email Non-Personal (noreply@, abuse@, legal@, privacy@): -15
    - Rating Rendah (< 3.0) dengan ulasan banyak: -10
    - Website hanya berupa tautan media sosial: -5
  * Seluruh bobot parameter dapat disesuaikan pada tab Otomasi > Skor Prospek 
    dan diuji secara instan melalui fitur "Simulasi Uji Bobot".

6.4 Antrean Persetujuan (Approval Queue):
  Kriteria Kualifikasi:
    - Status: Belum Dihubungi, memiliki alamat email terverifikasi, belum pernah dikirimi, 
      dan tidak terdaftar pada Daftar Pengecualian.
    - Nilai Skor >= Batas Minimal yang ditentukan.
    - Validasi Domain MX / Record A: Sistem melakukan pengecekan DNS aktif 
      (hasil cache 14 hari untuk domain valid, 3 hari untuk domain gagal).
    - Kebijakan 1 Bisnis 1 Email: Mencegah pengiriman ganda ke beberapa staf di domain yang sama.
  Kebijakan Operasional:
    - Kapasitas antrean maksimal 50 prospek secara bersamaan.
    - Opsi "Setujui" memvalidasi pengiriman pada siklus berikutnya, sedangkan "Tolak" 
      mengecualikan prospek secara permanen.

6.5 Siklus Follow-Up & Variasi A/B Testing:
  - Pesan follow-up otomatis dijadwalkan pada hari ke-N sejak pengiriman pertama 
    (default: Hari ke-4 dan Hari ke-10).
  - Siklus otomatis terhenti saat prospek memberikan balasan atau statusnya berubah.
  - Mendukung hingga 2 variasi pesan tambahan per tahap (A/B/C testing) untuk 
    menguji efektivitas judul dan copywriting email.


--------------------------------------------------------------------------------
7. STANDAR KEAMANAN & KEPATUHAN REGULASI (COMPLIANCE)
--------------------------------------------------------------------------------
Platform dirancang dengan mengedepankan kepatuhan penuh terhadap CAN-SPAM Act, GDPR, 
serta panduan pengirim Google & Yahoo:

1) Pembatalan Langganan (Unsubscribe System):
   - Setiap email menyertakan tautan Unsubscribe bertanda tangan digital (HMAC SHA-256) 
     serta header standar RFC 8058 List-Unsubscribe.
   - Penerima yang membatalkan langganan otomatis masuk ke Daftar Pengecualian 
     (hairleads:supp) dan status prospek diperbarui menjadi "Tidak Cocok".

2) Penanganan Bounce & Spam Otomatis (Webhook):
   - Terintegrasi dengan endpoint /api/mailhook?a=resend untuk memproses event 
     email.bounced dan email.complained.
   - Kasus hard bounce dan aduan spam langsung dimasukkan ke daftar blacklist permanen.

3) Circuit Breaker (Auto-Pause Perlindungan Reputasi):
   - Sistem secara proaktif memantau performa pengiriman. Jika rasio bounce 3 hari 
     terakhir melampaui batas (default: 4%) atau tercatat 2 laporan spam atau lebih, 
     sistem akan menghentikan seluruh pengiriman otomatis secara seketika untuk 
     melindungi domain pengirim dari pemblokiran.

4) Identitas Bisnis & Footer Email:
   - Mewajibkan pencantuman alamat fisik bisnis yang valid serta penjelasan sumber 
     perolehan kontak pada bagian footer setiap email penawaran.


--------------------------------------------------------------------------------
8. LAPORAN OPERASIONAL HARIAN, NOTIFIKASI SISTEM & PEMELIHARAAN DATA
--------------------------------------------------------------------------------
- Laporan Ringkasan Harian:
  Dikirimkan otomatis setiap hari ke alamat email administrator pasca eksekusi cron.
  Mencakup perolehan prospek baru, volume email terkirim, rasio balasan, tingkat bounce, 
  serta sisa kapasitas kuota SerpApi dan Resend.
- Sistem Peringatan Dini (Alerts):
  Mengirimkan notifikasi segera apabila terdeteksi kegagalan cron, kuota API kritis, 
  atau aktivasi Circuit Breaker akibat lonjakan bounce rate.
- Pemeliharaan Data Otomatis (Data Cleanup):
  Menjalankan optimasi basis data secara berkala untuk membersihkan prospek lama 
  yang tidak memiliki kontak, cache DNS yang kedaluwarsa, dan log sementara 
  guna menjaga efisiensi kapasitas Upstash Redis.


--------------------------------------------------------------------------------
9. DASBOR ANALITIK & UJI VARIASI PESAN A/B
--------------------------------------------------------------------------------
Menu Analisis > Dasbor Utama menyajikan pemantauan metrik komprehensif tanpa 
mengonsumsi kuota API:
  - Corong Konversi: Ditemukan > Memiliki Kontak > Terkirim > Dibalas > Deal.
  - Analisis Variasi Pesan A/B: Menggunakan uji statistik dua proporsi (z-test) 
    dengan tingkat kepercayaan 90% untuk menentukan variasi pesan pemenang.
  - Distribusi Wilayah: Pemetaan performa prospek dan konversi per negara dan kota.
  - Tren Historis: Grafik metrik aktivitas pengiriman dan respon selama 7, 14, 30, atau 90 hari.


--------------------------------------------------------------------------------
10. SKEMA STRUKTUR DATA REDIS
--------------------------------------------------------------------------------
Seluruh data menggunakan awalan namespace "hairleads:":
  hairleads:keys       Kunci API pihak ketiga dan alamat footer (terenkripsi)
  hairleads:cache      Cache data hasil pencarian Google Maps / OpenStreetMap
  hairleads:cmeta      Metadata ringkasan pencarian tersimpan (kota, kategori, timestamp)
  hairleads:leads      Data prospek, status konversi, catatan, dan kontak
  hairleads:ai         Cache skor dan evaluasi prospek dari model Gemini AI
  hairleads:mail       Log audit pengiriman email
  hairleads:mailday    Akumulasi volume pengiriman email per hari (format: YYYY-MM-DD)
  hairleads:mx         Cache validasi DNS MX dan Record A domain email
  hairleads:supp       Daftar pengecualian alamat (Unsubscribe, Bounce, Spam)
  hairleads:queue      Antrean kurasi prospek sebelum pengiriman otomatis
  hairleads:seq        State urutan pengiriman pesan follow-up berkala
  hairleads:auto       Konfigurasi otomasi, log riwayat eksekusi, dan state jeda
  hairleads:autolock   Kunci mutex untuk mencegah bentrok eksekusi simultan
  hairleads:stats      Agregasi statistik harian untuk dasbor analitik


--------------------------------------------------------------------------------
11. BATASAN SISTEM & REKOMENDASI INFRASTRUKTUR
--------------------------------------------------------------------------------
- Vercel Serverless Function:
  * Paket Hobby mengizinkan eksekusi Serverless Function maksimal 60 detik.
  * Cron harian berjalan sekali per hari pada jadwal yang ditentukan.
- Upstash Redis:
  * Kompatibel dengan tier gratis Upstash (10.000 perintah/hari) untuk skala wajar.
- Resend:
  * Kuota tier gratis: 100 email/hari (reset pukul 07.00 WIB / 00:00 UTC).
  * Pengiriman mewajibkan domain email kustom yang telah terverifikasi DNS.


--------------------------------------------------------------------------------
12. STRUKTUR DIREKTORI PROYEK
--------------------------------------------------------------------------------
├── api/
│   ├── _404.html         Halaman 404 stealth multi-bahasa
│   ├── _app.html         Antarmuka frontend utama (Single Page Application)
│   ├── _auth.js          Modul autentikasi sesi HMAC & cookie security
│   ├── _clean.js         Modul pemeliharaan dan pembersihan data usang
│   ├── _contacts.js      Pembersihan dan validasi format email & telepon
│   ├── _jobs.js          Mesin eksekusi tugas otomasi sistem
│   ├── _leads.js         Fungsi deduplikasi dan standardisasi prospek
│   ├── _mail.js          Gateway pengiriman email Resend, template HTML, & DNS MX
│   ├── _score.js         Algoritma penilaian kelayakan prospek (Rule-based)
│   ├── _serp.js          Konektor SerpApi dan mekanisme failover multi-akun
│   ├── _store.js         Abstraksi koneksi REST Upstash Redis & enkripsi simetris
│   ├── _template.js      Template pesan penjangkauan awal & konfigurasi brand
│   ├── ai.js             Endpoint evaluasi prospek cerdas via Google Gemini AI
│   ├── app.js            Gateway aplikasi & proteksi rute LOGIN_PATH
│   ├── auto.js           Endpoint API manajemen otomasi dan webhook cron
│   ├── dash.js           Endpoint analitik dasbor dan kalkulasi A/B testing
│   ├── keys.js           Endpoint pengelolaan kunci API terenkripsi
│   ├── leads.js          Endpoint manajemen status prospek dan pencarian
│   ├── mailhook.js       Endpoint penanganan webhook Resend dan tautan unsubscribe
│   ├── places.js         Endpoint pencarian data lokasi Google Maps & OpenStreetMap
│   ├── send.js           Endpoint pemrosesan pengiriman email cold outreach
│   ├── session.js        Endpoint otentikasi login, logout, dan proteksi brute-force
│   └── usage.js          Endpoint pemantauan sisa kuota SerpApi & ekstraksi kontak
├── vercel.json           Konfigurasi routing Vercel, serverless function, & jadwal cron
├── README.txt            Dokumentasi teknis teks lengkap (File ini)
└── README.md             Dokumentasi format Markdown resmi
================================================================================