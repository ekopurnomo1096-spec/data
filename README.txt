HAIR LEADS - PANDUAN
====================
Alat mencari prospek (salon, toko wig, toko kecantikan) lewat Google Maps, mencari email/WhatsApp
dari website mereka, lalu mengirim email penawaran dengan follow-up otomatis.
Semua data disimpan di Upstash Redis dengan awalan "hairleads:".

ISI
  1. Pasang pertama kali
  2. Variabel di Vercel
  3. Peta menu
  4. Cari dan simpan prospek
  5. Kirim email manual
  6. Otomatis (kirim, follow-up, cari ulang)
  7. Keamanan pengiriman
  8. Pembaca balasan (AI)
  9. Ringkasan harian, peringatan, pembersihan data
 10. Dasbor
 11. Data di Redis
 12. Batas yang perlu diketahui


1. PASANG PERTAMA KALI (sekali saja)
------------------------------------
1) Di Vercel, project ini: tab Storage > Connect database Upstash Redis yang sudah ada.
   Variabel koneksi terisi otomatis.
2) Project > Settings > Environment Variables, tambahkan APP_PASSWORD = kata sandi untuk masuk
   ke halaman ini (pilih yang panjang dan unik). Centang Production, Preview, Development.
3) Tambahkan juga LOGIN_PATH = teks rahasia bebas tanpa garis miring (contoh: masuk-x7q2). Ini
   alamat satu-satunya tempat halaman login muncul: https://domainmu.com/masuk-x7q2 - domain tanpa
   alamat ini (termasuk "/" polos) sengaja memberi 404, supaya orang lain yang iseng buka domainnya
   tidak nemu form login sama sekali. Ganti LOGIN_PATH kapan saja kalau alamatnya kebagi ke orang
   yang salah (sesi yang sudah login tidak kena pengaruh, cuma alamat masuk pertama kali yang beda).
   Lalu Deployments > titik tiga di deploy terbaru > Redeploy.
4) Buka https://domainmu.com/<LOGIN_PATH>, masuk, klik "Pengaturan", isi API key SerpApi (dan
   Geoapify, opsional). Key disimpan terenkripsi di Redis (hairleads:keys), berlaku di semua
   browser dan perangkat. Kalau APP_PASSWORD diganti, key harus diisi ulang.

Progress bar kuota SerpApi tampil di pojok kanan atas, diambil dari Account API SerpApi
(tidak mengurangi kuota).

PENTING: jangan menaruh API key, kata sandi, atau LOGIN_PATH di file aplikasi (api/_app.html) atau di GitHub - semua itu hanya boleh di Environment Variables Vercel.


2. VARIABEL DI VERCEL
---------------------
Setelah mengubah variabel, selalu Redeploy.

Wajib
  APP_PASSWORD            Kata sandi masuk.
  LOGIN_PATH              Alamat rahasia tempat halaman login muncul (lihat bagian 1, langkah 3).
                          Tanpa ini seluruh situs memberi 404, termasuk "/" - tidak ada yang bisa
                          masuk sama sekali, jadi wajib diisi.

Untuk fitur Otomatis (disarankan semua)
  CRON_SECRET             Teks acak panjang. Tanpa ini jadwal harian ditolak. Vercel mengirimnya
                          sendiri saat menjalankan cron.
  RESEND_WEBHOOK_SECRET   "whsec_..." dari Resend > Webhooks. Tanpa ini bounce dan laporan spam
                          tidak tercatat. Lihat bagian 7.
  UNSUB_SECRET            Teks acak panjang untuk tanda tangan link berhenti berlangganan. Isi SEKALI
                          dan jangan diganti lagi. Link di email lama tetap berlaku.
  PUBLIC_URL (opsional)   https://DOMAINMU, supaya link berhenti berlangganan selalu memakai
                          domain sendiri.

Opsional
  SERPAPI_KEY, GEOAPIFY_KEY            Cadangan kalau belum ada key tersimpan di halaman.
  RESEND_API_KEY, RESEND_FROM,
  RESEND_REPLY_TO                      Cadangan untuk pengaturan email di halaman.
  RESEND_DAILY_LIMIT                   Batas email per hari. Bawaan 100 (akun gratis Resend).
                                       Isi 0 untuk tanpa batas, atau angka sendiri.
  INBOUND_SECRET                       Untuk jalur umum balasan masuk (bagian 8).


3. PETA MENU
------------
Analisis
  Dasbor                   Corong, variasi A/B, statistik harian, per negara/kota (bagian 10).
Cari pembeli
  Cari tempat              Cari salon/toko di kota mana pun.
  Siapa yang membeli?      Panduan kelompok pembeli.
  Tersimpan                Prospek bertanda dan pencarian tersimpan.
Hubungi
  Email                    Kirim email manual.
  Balasan                  Balasan calon pembeli yang dibaca AI.
  Riwayat kirim            Semua email yang pernah dikirim.
Otomatis
  Status & antrean         Status (jalan otomatis, "Jalankan sekarang", jeda) dan Antrean persetujuan.
  Kirim email              Kirim otomatis, Pemanasan domain, Teks email.
  Cari prospek             Cari ulang, Putaran kota, Cari email.
  Sistem                   Skor prospek, Laporan & peringatan, Pembersihan data, Akun SerpApi,
                           Daftar berhenti.


4. CARI DAN SIMPAN PROSPEK
--------------------------
- Hasil pencarian disimpan di Redis (hairleads:cache). Mencari kota + jenis + sumber yang sama
  lagi membuka hasil tersimpan TANPA memakai kuota SerpApi. Tombol "Cari ulang" memaksa
  pencarian baru.
- 1 halaman Google Maps = 20 tempat = 1 kuota SerpApi.
- Duplikat dibuang otomatis: place_id sama, nama + alamat sama, atau nomor telepon sama dengan
  nama mirip. Cabang dengan alamat berbeda tidak dibuang.
- Status prospek dan catatan disimpan per tempat (hairleads:leads), jadi tempat yang sama di
  pencarian lain memakai status yang sama.
  Status: Belum dihubungi, Sudah dihubungi, Dibalas, Deal, Tidak cocok.


5. KIRIM EMAIL MANUAL (Resend)
------------------------------
Persiapan
  1. Di Resend: buat API key, dan verifikasi domain pengirim (Domains > Add domain, isi DNS-nya).
     Gmail/Yahoo tidak bisa dipakai sebagai pengirim.
  2. Di halaman: tab Email > "Pengaturan email", isi:
       API key Resend
       Email pengirim   contoh: EMA Hairshop Wholesale <sales@wholesale.emahairshop.com>
       Reply-To         email yang kamu baca (opsional tapi disarankan)
       Alamat fisik di footer email, dan "Keterangan sumber kontak" (lihat bagian 7)

Cara kirim
  - Satu tempat: buka detail tempat > Kirim email. Isi bisa diedit dulu.
  - Massal: tombol "Kirim email" di atas tabel. Hanya tempat berstatus Belum dihubungi yang punya
    email, maksimal 20 sekali kirim. Daftar bisa dicentang.
  - Manual: tab Email, ketik satu atau beberapa alamat (pisahkan koma), lalu kirim dengan subjek
    dan isi di tab itu. Dipakai juga untuk tes kirim ke emailmu sendiri.

Isi dan catatan
  - Isi memakai template di api/_template.js (sama dengan draf WA). Sapaan diganti nama tempat.
    Ada baris berhenti berlangganan di bawah.
  - Setelah terkirim, status otomatis jadi Sudah dihubungi dan catatan ditambah "Email, 3 Nov".
    Tempat yang sudah pernah dikirimi dilewati (dicatat di hairleads:mail).
  - Meter "email hari ini" menghitung email yang terkirim lewat halaman ini (hairleads:mailday),
    termasuk kirim manual. Batas bawaan 100 per hari, reset pukul 07.00 WIB (tengah malam UTC).
    Pilihan penerima dan tombol kirim otomatis mengikuti sisa kuota. Email yang dikirim dari luar
    halaman ini tidak ikut terhitung.


6. OTOMATIS (kirim, follow-up, cari ulang)
------------------------------------------
Semua berjalan tanpa AI (hanya aturan + Redis + Vercel Cron). Data berawalan hairleads:auto,
queue, seq, supp.

6.1 Jadwal
  - vercel.json menjalankan /api/auto?a=cron setiap hari pukul 18:00 UTC = 01:00 WIB
    ("0 18 * * *"). Zona waktu cron Vercel selalu UTC.
  - Paket Hobby hanya mengizinkan cron sekali sehari, dan jamnya bisa bergeser sampai satu jam.
  - Mengganti jam: ubah angka jam di vercel.json (UTC = WIB dikurangi 7), lalu deploy.
      01:00 WIB = 0 18 * * *      08:00 WIB = 0 1 * * *      14:00 WIB = 0 7 * * *
  - Kuota harian Resend reset 07:00 WIB (00:00 UTC), jadi jalan 01:00 WIB memakai kuota hari
    UTC yang sama dengan jalan 08:00 WIB hari itu.
  - Tombol "Jalankan sekarang" menjalankan semuanya langsung (jadwal cari ulang diabaikan, tetap
    dibatasi pengaturan). Bisa sampai 1 menit.

6.2 Urutan tiap jalan
  1. Kirim follow-up yang sudah waktunya + email pertama yang sudah disetujui.
  2. Cari ulang pencarian yang dicentang.
  3. Cari email/WhatsApp dari website tempat yang belum dicek.
  4. Isi antrean persetujuan dengan prospek yang skornya cukup.

6.3 Skor prospek (api/_score.js, 0-100)
  Menambah
    email +30 (+5 kalau bukan Gmail dkk) · website +10 · WhatsApp +5 · telepon +5
    rating 4,5+ +10 / 4+ +6 / 3,5+ +3
    ulasan 100+ +10 / 30+ +7 / 10+ +4
    nama wig/extension/weave/beauty supply/wholesale +15
    nama salon/hair/beauty/studio +8
  Mengurangi (sinyal negatif)
    jaringan besar (Sally Beauty, Ulta, Walmart dll) -50
    bukan bisnis rambut (barber, nail, spa, tattoo, klinik, sekolah, lash) -15
    email tidak dibaca orang (noreply, abuse, privacy, legal dll) -15
    rating di bawah 3,0 dengan 10+ ulasan -10
    ada rating tapi ulasan kurang dari 3 -3
    website hanya Facebook/Instagram dll -5
  Cara mengubah
    - Tab Otomatis > Skor prospek. Bobot tersimpan di cfg.mail.weights (tanpa deploy ulang).
    - Sinyal negatif diisi angka POSITIF lalu dikurangkan. Isi 0 untuk mematikan satu sinyal.
    - "Uji bobot" menghitung ulang prospek yang memenuhi syarat antrean dengan bobot di form
      (belum disimpan): berapa yang lolos batas, sebaran skor, contoh teratas, dekat batas, dan
      yang kena sinyal negatif. "Kembalikan bawaan" mengisi ulang bobot standar.
    - Perubahan berlaku setelah Simpan pengaturan, dan hanya untuk prospek yang diantrekan
      sesudahnya (yang sudah di antrean tidak dihitung ulang).
    - Daftar kata jaringan besar, bukan bisnis rambut, dan email tidak dibaca orang ada di
      api/_score.js. Nama yang memuat wig/extension/weave dan sejenisnya tidak pernah dikurangi
      sebagai bukan bisnis rambut.
    - Antrean menampilkan alasan skor, sinyal negatif di depan.

6.4 Antrean persetujuan
  Syarat masuk antrean:
    - Status Belum dihubungi, punya email, belum pernah dikirimi, tidak ada di Daftar berhenti.
    - Skor >= batas.
    - Alamat punya MX/alamat A (dicek lewat DNS, tanpa API; hasil di hairleads:mx, 14 hari untuk
      valid, 3 hari untuk gagal). Domain yang belum pasti ditunda ke jalan berikutnya, bukan ditolak.
    - Satu bisnis satu email: domain email milik sendiri (bukan Gmail dkk) dan host website yang
      sama dengan yang sudah dikirimi/diantrekan dilewati, jadi info@ dan owner@ domain yang sama
      tidak keduanya terkirim, dan cabang dengan website sama tidak terkirim berulang. Website
      sosial/marketplace (Facebook, Instagram, Shopify dll) tidak dihitung.
  Aturan lain:
    - Maksimal 50 menunggu persetujuan sekaligus.
    - "Tolak" = tidak diantrekan lagi.
    - Hanya yang disetujui yang dikirim, maksimal "email per hari" di pengaturan dan tidak melewati
      sisa kuota Resend.
    - Setelah terkirim, status jadi Sudah dihubungi dan catatan ditambah "Email, 3 Nov".
    - Isi email memakai template di tab Otomatis (sapaan Hi! -> Hi Nama team!).

6.5 Follow-up dan variasi email
  - Follow-up dikirim hari ke-N sejak email pertama (bawaan hari ke-4 dan ke-10).
  - Berhenti sendiri kalau status jadi Dibalas / Deal / Tidak cocok, atau alamatnya masuk Daftar
    berhenti.
  - Tiap tahap (email pertama dan tiap follow-up) bisa punya sampai 2 variasi tambahan (A, B, C).
    Penerima berurutan mendapat A, B, C, A, ... per tahap. Follow-up bawaan sudah punya 1 variasi
    tambahan.
  - Variasi yang terkirim dicatat di urutan (hairleads:seq, field vs) dan di statistik harian
    (metrik s{tahap}v{variasi}). Yang dibalas dicatat sebagai r{tahap}v{variasi}.
    Perbandingannya tampil di Dasbor.

6.6 Pemanasan domain (warm-up)
  - Batas harian mulai dari 10, naik 5 tiap 3 hari sampai target (bawaan 20), dihitung dari hari
    email pertama terkirim.
  - Batas ini TOTAL per hari (otomatis + follow-up + kirim manual), jadi menekan "Jalankan
    sekarang" berkali-kali tidak melewatinya.
  - Matikan di Pengaturan otomatis kalau domain sudah lama dipakai.

6.7 Cari ulang
  - Hanya pencarian yang dicentang. 1 halaman Google Maps (20 tempat) = 1 kuota SerpApi.
  - Halaman 2 dan 3 hanya diambil kalau seluruh isi halaman sebelumnya tempat baru (bisa diatur
    1-3 di "Halaman per pencarian"). Tiap halaman dihitung ke "Maks pencarian per hari".
  - Dilewati kalau sisa kuota di bawah "Sisakan kuota SerpApi".
  - Tempat lama tidak berubah, hanya yang baru ditambahkan.
  - Nonaktifkan pencarian kosong: kalau satu pencarian yang dicentang berturut-turut tidak
    menambah tempat baru sebanyak "Matikan setelah kosong" (bawaan 3, isi 0 untuk mematikan
    aturan), centangnya dimatikan sendiri dan kamu dikabari lewat email peringatan (maks sekali
    sehari). Kalau ada tempat baru, hitungan kembali ke nol. Satu pencarian dihitung paling
    banyak sekali per 20 jam. Hitungan ada di hairleads:auto, field dry. Untuk mengaktifkan lagi,
    centang kembali pencariannya.

6.8 Putaran kota
  - Daftar kota (satu per baris, "Kota, Negara") x jenis (salon / toko wig / kecantikan).
  - Tiap jalan mengambil kombinasi BERIKUTNYA yang belum pernah dicari, jadi kuota SerpApi dipakai
    untuk kota baru, bukan mengulang. Kombinasi yang sudah ada di pencarian tersimpan dilewati.
    Yang hasilnya kosong atau gagal (bukan karena kuota) tetap dianggap sudah dicoba supaya
    putaran tidak macet.
  - Daftar bawaan: kota besar AS, Inggris, Kanada, Nigeria, Afrika Selatan, Ghana, dan Kenya.
  - Batas: "Maks pencarian per hari" (bawaan 2, per hari UTC), "Sisakan kuota SerpApi" (bawaan 30),
    halaman per kota (bawaan 1). Hitungan terpisah dari "Cari ulang".
  - Hanya jalan kalau dicentang, juga saat "Jalankan sekarang".
  - Progres tampil di Pengaturan (mis. "12 dari 28 kombinasi sudah dicari"). Data di
    hairleads:auto, field rot dan rotday.
  - Kota yang sudah dicari tidak otomatis ikut Cari ulang; centang manual kalau mau.

6.9 Cari email dari website
  - Maksimal 60 website per jalan (bisa diubah). Sisanya dilanjutkan di jalan berikutnya.
  - Halaman yang dicek: /contact, /about, /pages/contact (pola Shopify), /contact-us, /kontak,
    dan tautan "Contact/Kontak" di halaman utama (maks 6 halaman per website).
  - Website yang gagal dijangkau (timeout, error server) TIDAK langsung ditandai selesai: dicoba
    ulang SEKALI, paling cepat 20 jam kemudian. Website yang terbuka tapi tanpa email tetap final.
    Hasil jalan menampilkan "retry" dan "waiting".

6.10 Pindah akun SerpApi otomatis
  - Berlaku kalau Akun 1 dan Akun 2 sama-sama diisi.
  - Sebelum tiap pencarian Google Maps (manual maupun otomatis), sisa kuota akun aktif dicek lewat
    Account API SerpApi (gratis). Kalau di bawah "Pindah kalau sisa di bawah" (bawaan 20) dan
    akun lain punya sisa lebih banyak, akun aktif dipindah. Sama dengan switch di pojok kanan atas,
    jadi pilihan manual tetap bisa diganti kapan saja.
  - Kalau SerpApi menolak pencarian karena kuota habis / key bermasalah, pencarian diulang sekali
    dengan akun lain dan akun aktif dipindah.
  - Pindah lewat jadwal harian dikabari lewat email peringatan (maks sekali sehari).
  - Pengaturan di cfg.serp {auto, below}. Pindah terakhir di hairleads:auto, field serpsw.
    Matikan kotaknya kalau mau memilih akun murni manual.


7. KEAMANAN PENGIRIMAN
----------------------
Berlaku untuk kirim otomatis DAN manual.

Berhenti berlangganan
  - Setiap email memuat tautan "Unsubscribe" bertanda tangan + header List-Unsubscribe (tombol
    berhenti di Gmail/Apple Mail).
  - Tautan hanya menampilkan tombol konfirmasi; yang benar-benar berhenti adalah klik tombolnya.
  - Alamat di Daftar berhenti dilewati semua jalur kirim. Bisa ditambah/dihapus manual di tab
    Otomatis.

Bounce dan spam (webhook Resend)
  - Di Resend > Webhooks, tambahkan webhook ke https://DOMAINMU/api/mailhook?a=resend dengan event
    email.bounced dan email.complained. Isi RESEND_WEBHOOK_SECRET di Vercel.
  - Bounce permanen dan laporan spam otomatis masuk Daftar berhenti. Bounce sementara (kotak
    penuh dll) tidak.
  - Bounce, laporan spam, dan berhenti berlangganan juga mengubah status prospek jadi "Tidak
    cocok" + catatan, hanya kalau statusnya masih Belum dihubungi / Sudah dihubungi.
    Dibalas/Deal tidak diubah.

Jeda
  - Tombol "Jeda semua" (kill switch) di bagian Status: menghentikan kirim otomatis, follow-up,
    semua pekerjaan cron, DAN kirim manual dari tab Email sampai klik Lanjutkan.
  - Jeda otomatis: kalau bounce 3 hari terakhir >= batas (bawaan 4%, minimal 20 email terkirim)
    atau ada 2+ laporan spam (>= 0,3%), sistem menjeda sendiri. Dicek tiap webhook bounce/spam
    masuk dan tiap pekerjaan berjalan.
  - Setelah Lanjutkan, hitungan bounce yang ada dijadikan titik nol supaya tidak langsung terjeda
    lagi.

Footer email (alamat fisik dan sumber kontak)
  - Tab Email > Pengaturan email > isi "Alamat fisik di footer email" (kantor, toko, atau PO Box).
    Tampil di bawah SETIAP email (otomatis dan manual), di versi HTML maupun teks.
  - "Keterangan sumber kontak" opsional. Kalau kosong, memakai teks bawaan: We found your email
    address on your business website or public listing.
  - Isi dua kolom ini SEBELUM kirim sungguhan. Tab Otomatis menampilkan peringatan merah selama
    alamat fisik belum diisi. Pengiriman tidak diblokir.
  - Disimpan terenkripsi di Redis bersama key lain (field addr dan srcn di hairleads:keys).


8. PEMBACA BALASAN (AI)
-----------------------
Tab Otomatis > Balasan (AI). Balasan calon pembeli dibaca Gemini (key yang sama dengan fitur AI
lain) lalu dikelompokkan: Tertarik, Bertanya, Menolak, Minta berhenti, Balasan otomatis, Lainnya.

Efek ke prospek (api/_reply.js)
  Tertarik / Bertanya / Lainnya   -> status Dibalas
  Menolak                         -> Tidak cocok
  Minta berhenti                  -> Tidak cocok + masuk Daftar berhenti
  Balasan otomatis (di luar kantor) -> status tidak berubah
  Deal tidak pernah diturunkan. Dibalas / Tidak cocok menghentikan follow-up sendiri.
  Catatan prospek ditambah "Balasan email, 4 Nov: ...".

Lain-lain
  - Pengirim dicocokkan dengan prospek lewat alamat yang pernah dikirimi (riwayat kirim / urutan
    follow-up / email hasil cari website); kalau tidak ada, lewat domain email milik sendiri yang
    sama (bukan Gmail dkk). Tidak cocok = balasan tetap disimpan tapi status tidak berubah.
  - AI juga menulis DRAF balasan (bahasa sama dengan pengirim, hanya memakai fakta brand). Draf
    TIDAK pernah dikirim otomatis: salin dan kirim sendiri. Isi balasan dianggap data, bukan
    perintah; keluaran AI divalidasi.
  - Kalau key Gemini kosong atau Gemini gagal, dipakai pengelompokan kata kunci sederhana
    (ditandai "tanpa AI").
  - Tertarik / Bertanya mengirim email peringatan ke penerima laporan.
  - Balasan yang sama (id pesan sama) hanya dihitung sekali. Setelah balasan masuk, buka ulang
    halaman supaya status di daftar tempat ikut ter-update.
  - Data di hairleads:replies; hitungan harian di statistik (metrik reply).

Cara balasan masuk (pilih salah satu atau semuanya)
  1. Resend Receiving
     - Di Resend aktifkan Receiving untuk domain pengirim (tambah record MX).
     - Tambahkan event email.received ke webhook yang sama (/api/mailhook?a=resend,
       RESEND_WEBHOOK_SECRET sama).
     - Isi Reply-To (tab Email > Pengaturan email) dengan alamat di domain itu, mis.
       reply@domainmu.com. Isi email diambil lewat API Resend.
     - Catatan: kalau Reply-To dipakai untuk kotak masuk pribadi, balasan tidak lewat Resend.
       Pakai jalur 2 atau 3.
  2. Jalur umum
     - Isi INBOUND_SECRET di Vercel, lalu teruskan balasan dari Gmail (Apps Script), Zapier, Make,
       atau Cloudflare Email Worker dengan POST JSON {from, subject, text} ke
       https://DOMAINMU/api/mailhook?a=inbound&k=INBOUND_SECRET (atau header x-inbound-key).
  3. Manual
     - Tab Otomatis > Balasan (AI) > Tempel balasan manual.


9. RINGKASAN HARIAN, PERINGATAN, PEMBERSIHAN DATA
-------------------------------------------------
Tab Otomatis > Pengaturan > Laporan & peringatan.

Ringkasan harian
  - Dikirim lewat Resend setelah jalan otomatis harian (sekitar 01:00 WIB), sekali sehari.
  - Isi: prospek baru, kontak ditemukan, email pertama dan follow-up terkirim, bounce, spam,
    berhenti langganan (hari ini dan kemarin), status kirim otomatis, jumlah menunggu
    persetujuan, sisa kuota Resend dan SerpApi tiap akun.
  - "Hari ini" di ringkasan = sejak 07.00 WIB (awal hari UTC), termasuk jalan otomatis itu.
  - Penerima: isi "Kirim ke email". Kalau kosong, memakai Reply-To dari tab Email. Dikirim dari
    alamat pengirim Resend yang sama.
  - Tombol "Kirim tes ringkasan" mengirim sekarang (simpan pengaturan dulu).

Peringatan (email terpisah, "[Peringatan] ...")
  Hanya dari jalan terjadwal dan webhook, maksimal sekali sehari per jenis:
    - jeda otomatis karena bounce atau spam (selalu dikirim setiap terjadi)
    - jadwal harian terlewat (jalan terakhir lebih dari 30 jam lalu, dicek saat jalan berikutnya)
    - jalan otomatis gagal (error pekerjaan)
    - kuota Resend habis atau terlalu cepat
    - pencarian ulang gagal karena SerpApi, atau dilewati karena sisa kuota di bawah batas
    - pindah akun SerpApi, dan pencarian kosong dinonaktifkan
  Batas: kalau cron Vercel tidak jalan sama sekali, tidak ada kode yang berjalan untuk memberi
  tahu. Peringatan "terlewat" baru terkirim saat jalan berikutnya. Untuk jaga-jaga, pasang monitor
  uptime eksternal.
  Email laporan tidak ikut meter "email hari ini", tapi tetap memakai kuota Resend yang sebenarnya.

Pembersihan data
  - Berjalan di akhir "Jalankan sekarang" dan jadwal harian, paling banyak sekali per 20 jam
    (maks 40 pencarian per jalan).
  - Sasaran: pencarian yang lebih tua dari "Umur data" (bawaan 30 hari) dan tidak dicentang
    untuk cari ulang.
  - Dibuang: tempat tanpa telepon, email, dan WhatsApp, setelah websitenya dicek (atau tanpa
    website). Pencarian yang jadi kosong ikut dihapus.
  - Ikut dibersihkan: skor AI dan catatan cek email milik tempat itu (kalau tidak dipakai
    pencarian lain), cache domain email yang kedaluwarsa, statistik harian lebih dari 90 hari.
  - TIDAK PERNAH dibuang: tempat yang punya status atau catatan, pernah dikirimi email, ada di
    antrean, atau urutan follow-up, serta tempat yang websitenya belum dicek.
  - Hasilnya tampil di Riwayat jalan dan bagian Pembersihan data. Data yang dibuang tidak
    diarsipkan, tapi pencarian yang sama bisa diulang kapan saja (memakai kuota SerpApi).


10. DASBOR (menu Analisis > Dasbor)
------------------------------------
Menu sendiri, hanya baca (api/dash.js). Dimuat saat menu dibuka atau tombol Segarkan ditekan,
karena membaca seluruh pencarian tersimpan. Tidak memakai kuota SerpApi maupun Resend.
Jendela waktu: 7 / 14 / 30 / 90 hari (statistik harian disimpan 90 hari).

Isi
  - Ringkasan: tempat tersimpan, email terkirim, balasan, tingkat balasan, bounce.
  - Corong (seluruh data tersimpan):
      Ditemukan > Punya kontak (email atau WA) > Dikirimi (riwayat kirim, urutan follow-up, atau
      sudah berstatus) > Dibalas (balasan manusia, bukan balasan otomatis atau permintaan berhenti;
      atau status Dibalas/Deal) > Deal.
  - Variasi A/B per tahap: terkirim, dibalas, tingkat balasan. Pemenang hanya ditandai kalau tiap
    variasi sudah terkirim minimal 30 kali dan selisihnya lolos uji dua proporsi (sekitar 90%
    yakin). Selain itu tampil "belum cukup data" atau "belum ada pemenang". Batas 30 ada di
    MIN_SENT pada api/dash.js. Hanya kiriman lewat jalur Otomatis yang bertanda variasi.
  - Per negara dan per kota: negara = teks setelah koma terakhir pada nama kota pencarian. Satu
    tempat dihitung sekali, di pencarian pertama yang memuatnya.
  - Statistik harian: email, follow-up, bounce, spam, berhenti, balasan, tempat baru, ada kontak.
    Tanggal UTC (ganti hari pukul 07.00 WIB), sama seperti kuota Resend.
  - Tren harian dan jenis balasan (Tertarik, Bertanya, dst).


11. DATA DI REDIS (semua berawalan "hairleads:")
------------------------------------------------
  keys       API key dan alamat footer (terenkripsi)
  cache      Hasil pencarian tersimpan        cmeta    Ringkasan tiap pencarian (kota, jenis)
  leads      Status dan catatan per tempat    ai       Skor AI per tempat
  mail       Riwayat kirim                    mailday  Hitungan email per hari
  mx         Cache cek domain email           supp     Daftar berhenti
  queue      Antrean persetujuan              seq      Urutan follow-up
  auto       Pengaturan, log, jeda, progres   autolock Kunci agar dua jalan tidak bentrok
  stats      Statistik harian (field "YYYY-MM-DD:metrik", UTC)
  replies    Balasan masuk yang sudah dibaca AI


12. BATAS YANG PERLU DIKETAHUI
------------------------------
  - Paket Hobby Vercel: cron sekali sehari (jam bisa bergeser sampai satu jam), tiap fungsi
    maksimal 60 detik (vercel.json).
  - Resend gratis: 100 email per hari. Atur RESEND_DAILY_LIMIT kalau akun berbayar.
  - Gmail/Yahoo tidak bisa jadi pengirim, dan antrean otomatis hanya untuk alamat Gmail/Yahoo dkk.
  - Draf balasan AI tidak pernah dikirim otomatis.
  - Mengganti APP_PASSWORD mematikan key tersimpan (isi ulang di Pengaturan). Link berhenti
    berlangganan baru tidak terpengaruh kalau UNSUB_SECRET sudah diisi.


CATATAN BATAS VERCEL HOBBY
--------------------------
Paket Hobby maksimal 12 Serverless Function (setiap file api/*.js tanpa awalan "_" dihitung satu).
Sekarang tepat 12. Jangan menambah file baru di api/ tanpa menggabungkan yang lain. Pencarian
email/WhatsApp (dulu api/email.js) sekarang ada di api/usage.js lewat ?a=email.
