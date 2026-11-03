CARA PASANG (sekali saja)
1. Di Vercel, project ini: tab Storage > Connect database Upstash Redis yang sudah ada (variabel koneksi terisi otomatis).
2. Project > Settings > Environment Variables, tambahkan SATU variabel:
     APP_PASSWORD = kata sandi untuk masuk ke halaman ini (pilih yang panjang dan unik)
   Centang Production, Preview, Development. Lalu Deployments > titik tiga di deploy terbaru > Redeploy.
3. Buka halaman, masuk, klik "Pengaturan", isi API key SerpApi (dan Geoapify, opsional). Cukup sekali.
   Key disimpan terenkripsi di Redis (data berawalan "hairleads:"), berlaku di semua browser dan perangkat.
   Kalau APP_PASSWORD diganti, key harus diisi ulang.

Progress bar kuota SerpApi tampil di pojok kanan atas, diambil dari Account API SerpApi (tidak mengurangi kuota).

(Opsional) SERPAPI_KEY / GEOAPIFY_KEY di Vercel tetap dipakai sebagai cadangan kalau belum ada key tersimpan.
JANGAN menaruh API key atau kata sandi di index.html atau di GitHub.

FITUR SIMPAN, STATUS, DAN CATATAN (otomatis, tidak perlu pengaturan tambahan selain Upstash Redis)
- Hasil pencarian disimpan di Redis (hairleads:cache). Mencari kota + jenis + sumber yang sama lagi membuka hasil tersimpan tanpa memakai kuota SerpApi. Tombol "Cari ulang" memaksa pencarian baru.
- Duplikat dibuang otomatis: place_id sama, nama + alamat sama, atau nomor telepon sama dengan nama mirip. Cabang dengan alamat berbeda tidak dibuang.
- Status prospek dan catatan disimpan per tempat (hairleads:leads), jadi tempat yang sama di pencarian lain memakai status yang sama.

KIRIM EMAIL (Resend, opsional)
- Di Resend: buat API key, dan verifikasi domain pengirim (Domains > Add domain, lalu isi DNS-nya). Gmail/Yahoo tidak bisa dipakai sebagai pengirim.
- Di halaman ini: tab Email > buka "Pengaturan email" > isi "API key Resend", "Email pengirim" (mis. EMA Hairshop Wholesale <sales@wholesale.emahairshop.com>), dan "Reply-To" (email yang kamu baca, opsional tapi disarankan). Cadangan: RESEND_API_KEY, RESEND_FROM, RESEND_REPLY_TO di Vercel.
- Satu tempat: buka detail tempat > Kirim email. Isi bisa diedit dulu.
- Massal: tombol "Kirim email" di atas tabel. Hanya tempat berstatus Belum dihubungi yang punya email, maksimal 20 sekali kirim. Daftar bisa dicentang.
- Isi email memakai template di api/_template.js (sama dengan draf WA) dan sapaan diganti nama tempat. Ada baris berhenti berlangganan di bagian bawah.
- Setelah terkirim, status otomatis jadi Sudah dihubungi dan catatan ditambah "Email, 3 Nov". Tempat yang sudah pernah dikirimi dilewati (dicatat di hairleads:mail).
- Meter "email hari ini" di tab Email menghitung email yang terkirim lewat halaman ini (dicatat di hairleads:mailday). Batas bawaannya 100 per hari, sesuai akun gratis Resend, dan reset jam 07.00 WIB (tengah malam UTC). Pilihan penerima dan tombol kirim otomatis mengikuti sisa kuota. Kalau akun Resend berbayar, tambahkan RESEND_DAILY_LIMIT di Vercel (isi 0 untuk tanpa batas, atau angka lain untuk batas sendiri). Email yang dikirim dari luar halaman ini tidak ikut terhitung.
- Kirim manual (tab Email): ketik satu atau beberapa alamat email (pisahkan dengan koma), lalu kirim memakai subjek dan isi email di tab itu. Dipakai juga untuk tes kirim ke emailmu sendiri. Ikut dihitung di meter harian.

OTOMATIS (tab "Otomatis")
Semua berjalan tanpa AI, hanya aturan + Redis + Vercel Cron. Data di Redis berawalan "hairleads:" (auto, queue, seq, supp).
Pasang sekali (Vercel > Settings > Environment Variables, centang Production, lalu Redeploy):
  CRON_SECRET            = teks acak panjang. Tanpa ini jadwal harian ditolak. Vercel otomatis mengirimnya saat menjalankan cron.
  RESEND_WEBHOOK_SECRET  = "whsec_..." dari Resend > Webhooks. Tambahkan webhook ke  https://DOMAINMU/api/mailhook?a=resend
                           dengan event email.bounced dan email.complained. Tanpa ini bounce dan laporan spam tidak tercatat.
  UNSUB_SECRET (disarankan) = teks acak panjang khusus untuk tanda tangan link berhenti berlangganan. Isi SEKALI dan jangan diganti lagi.
                           Link di email lama (yang dibuat dari APP_PASSWORD) tetap berlaku, jadi aman diisi kapan saja. Setelah ini, mengganti APP_PASSWORD tidak lagi mematikan link baru.
  PUBLIC_URL (opsional)  = https://DOMAINMU  supaya tautan berhenti berlangganan di email selalu memakai domain sendiri.
Jadwal: vercel.json menjalankan /api/auto?a=cron setiap hari 01:00 UTC (08.00 WIB), setelah kuota harian Resend reset. Paket Hobby hanya mengizinkan cron sekali sehari, dan jamnya bisa bergeser dalam jam itu.
Tombol "Jalankan sekarang" menjalankan semuanya langsung (cari ulang diabaikan jadwalnya, tetap dibatasi pengaturan).

Urutan tiap jalan: (1) kirim follow-up yang sudah waktunya + email pertama yang sudah disetujui, (2) cari ulang pencarian yang dicentang,
(3) cari email/WhatsApp dari website tempat yang belum dicek, (4) isi antrean persetujuan dengan prospek yang skornya cukup.
- Skor (api/_score.js, 0-100, ubah bobot di situ): email +30 (+5 kalau bukan Gmail dkk), website +10, WhatsApp +5, telepon +5, rating, jumlah ulasan, kata di nama (wig/extension/weave/beauty supply, salon/hair/beauty).
- Antrean: prospek berstatus Belum dihubungi, punya email, belum pernah dikirimi, tidak ada di Daftar berhenti, skor >= batas. Maksimal 50 menunggu persetujuan sekaligus. "Tolak" = tidak diantrekan lagi.
- Kirim: hanya yang disetujui, maksimal "email per hari" di pengaturan dan tidak melewati sisa kuota Resend. Setelah terkirim, status jadi Sudah dihubungi dan catatan ditambah "Email, 3 Nov" (sama seperti kirim manual). Isi email memakai template di tab Otomatis (sapaan Hi! -> Hi Nama team!).
- Follow-up: hari ke-N sejak email pertama (bawaan 4 dan 10). Berhenti sendiri kalau status jadi Dibalas / Deal / Tidak cocok, atau alamatnya masuk Daftar berhenti.
- Cari ulang: hanya pencarian yang dicentang. 1 pencarian Google Maps = 1 kuota SerpApi (hanya halaman pertama, 20 tempat). Dilewati kalau sisa kuota di bawah angka "Sisakan kuota SerpApi". Tempat lama tidak berubah, hanya yang baru ditambahkan.
- Cari email: maksimal 60 website per jalan (bisa diubah). Sisanya dilanjutkan di jalan berikutnya.

BERHENTI BERLANGGANAN, BOUNCE, SPAM (berlaku untuk kirim otomatis DAN manual)
- Setiap email memuat tautan "Unsubscribe" bertanda tangan + header List-Unsubscribe (tombol berhenti di Gmail/Apple Mail). Tautan hanya menampilkan tombol konfirmasi; yang benar-benar berhenti adalah klik tombolnya.
- Bounce permanen dan laporan spam (webhook Resend) otomatis masuk Daftar berhenti. Bounce sementara (kotak penuh dll) tidak.
- Alamat di Daftar berhenti dilewati oleh semua jalur kirim. Bisa ditambah/dihapus manual di tab Otomatis.

PENYEMPURNAAN TAMBAHAN
- Cari email: selain /contact dan /about, sekarang juga /pages/contact (pola Shopify), /contact-us, /kontak, dan tautan "Contact/Kontak" yang ditemukan di halaman utama (maks 6 halaman per website).
- Website yang gagal dijangkau (timeout, error server) TIDAK langsung ditandai selesai: dicoba ulang SEKALI, paling cepat 20 jam kemudian. Website yang terbuka tapi tanpa email tetap final. Hasil jalan menampilkan "retry" dan "waiting".
- Antrean: alamat harus punya MX/alamat A (dicek lewat DNS, tanpa API, hasil disimpan di hairleads:mx, 14 hari untuk valid, 3 hari untuk gagal). Domain yang belum bisa dipastikan ditunda ke jalan berikutnya, bukan ditolak.
- Antrean: satu bisnis satu email. Domain email milik sendiri (bukan Gmail dkk) dan host website yang sama dengan yang sudah dikirimi/diantrekan dilewati, jadi info@ dan owner@ domain yang sama tidak keduanya terkirim, dan cabang dengan website yang sama tidak terkirim berulang. Website sosial/marketplace (Facebook, Instagram, Shopify dll) tidak dihitung.
- Bounce, laporan spam, dan berhenti berlangganan sekarang juga mengubah status prospek jadi "Tidak cocok" + catatan (hanya kalau statusnya masih Belum dihubungi / Sudah dihubungi; Dibalas/Deal tidak diubah).

VARIASI, PEMANASAN, JEDA, STATISTIK (tab Otomatis)
- Variasi email: tiap tahap (email pertama dan tiap follow-up) bisa punya sampai 2 variasi tambahan (A, B, C). Penerima berurutan mendapat A, B, C, A, ... per tahap. Variasi yang terkirim dicatat di urutan (hairleads:seq, field vs) dan di statistik harian (metrik s{tahap}v{variasi}), jadi nanti bisa dibandingkan mana yang dibalas. Follow-up bawaan sudah punya 1 variasi tambahan; ubah sesukamu.
- Pemanasan: batas harian mulai dari 10, naik 5 tiap 3 hari sampai target (bawaan 20), dihitung dari hari email pertama terkirim (hairleads:auto, field first). Batas ini adalah TOTAL per hari (otomatis + follow-up + kirim manual), jadi menekan "Jalankan sekarang" berkali-kali tidak melewatinya. Matikan di Pengaturan otomatis kalau domain sudah lama dipakai.
- Statistik harian: hairleads:stats, field "YYYY-MM-DD:metrik" (UTC). Tampil 7 hari di tab Otomatis.
- Jeda semua (kill switch): tombol di bagian Status. Menghentikan kirim otomatis, follow-up, semua pekerjaan cron, DAN kirim manual dari tab Email sampai klik Lanjutkan.
- Jeda otomatis: kalau bounce 3 hari terakhir >= batas (bawaan 4%, minimal 20 email terkirim) atau ada 2+ laporan spam (>= 0,3%), sistem menjeda sendiri. Dicek tiap webhook bounce/spam masuk dan tiap kali pekerjaan berjalan. Setelah Lanjutkan, hitungan bounce yang ada dijadikan titik nol supaya tidak langsung terjeda lagi.

FOOTER EMAIL (alamat fisik dan sumber kontak)
- Tab Email > Pengaturan email > isi "Alamat fisik di footer email" (kantor, toko, atau PO Box). Tampil di bawah SETIAP email (otomatis dan manual), di versi HTML maupun teks.
- "Keterangan sumber kontak" opsional. Kalau kosong, memakai teks bawaan: We found your email address on your business website or public listing.
- Isi dua kolom ini SEBELUM kirim sungguhan. Tab Otomatis menampilkan peringatan merah selama alamat fisik belum diisi. Pengiriman tidak diblokir.
- Disimpan terenkripsi di Redis bersama key lain (field addr dan srcn di hairleads:keys).

TAMPILAN TAB OTOMATIS
- Status tampil sebagai kartu kecil, riwayat jalan dilipat.
- Antrean, Statistik, dan Daftar berhenti berupa panel yang bisa dibuka-tutup.
- Pengaturan dipecah per bagian yang bisa dilipat: Kirim otomatis, Pemanasan domain, Teks email, Cari ulang, Cari email.
- Teks email: tiap tahap (email pertama, follow-up) dan tiap variasi dilipat. Judulnya menampilkan hari kirim, jumlah teks, dan subjek.

RINGKASAN HARIAN, PERINGATAN, PEMBERSIHAN DATA (tab Otomatis > Pengaturan)
- Ringkasan harian: dikirim lewat Resend setelah jalan otomatis pagi (08.00 WIB), sekali sehari. Isinya prospek baru, kontak ditemukan, email pertama dan follow-up terkirim, bounce, spam, berhenti langganan (hari ini dan kemarin), status kirim otomatis, jumlah menunggu persetujuan, sisa kuota Resend dan SerpApi tiap akun. Tombol "Kirim tes ringkasan" mengirim sekarang (simpan pengaturan dulu).
- Penerima: isi "Kirim ke email". Kalau kosong, memakai Reply-To dari tab Email. Dikirim dari alamat pengirim Resend yang sama.
- Peringatan (email terpisah, "[Peringatan] ..."), hanya dari jalan terjadwal dan webhook, maksimal sekali sehari per jenis:
    * jeda otomatis karena bounce atau spam (selalu dikirim setiap terjadi)
    * jadwal harian terlewat (jalan terakhir lebih dari 30 jam lalu, dicek saat jalan berikutnya)
    * jalan otomatis gagal (error pekerjaan)
    * kuota Resend habis atau terlalu cepat
    * pencarian ulang gagal karena SerpApi, atau dilewati karena sisa kuota di bawah batas "Sisakan kuota SerpApi"
  Batas: kalau cron Vercel tidak jalan sama sekali, tidak ada kode yang berjalan untuk memberi tahu. Peringatan "terlewat" baru terkirim saat jalan berikutnya. Untuk jaga-jaga, pasang monitor uptime eksternal.
- Email laporan tidak ikut meter "email hari ini", tapi tetap memakai kuota Resend yang sebenarnya.
- Pembersihan data: berjalan di akhir "Jalankan sekarang" dan jadwal harian, paling banyak sekali per 20 jam (maks 40 pencarian per jalan). Pada pencarian yang lebih tua dari "Umur data" (bawaan 30 hari) dan tidak dicentang untuk cari ulang:
    * dibuang: tempat tanpa telepon, email, dan WhatsApp, setelah websitenya dicek (atau tanpa website). Pencarian yang jadi kosong ikut dihapus.
    * ikut dibersihkan: skor AI dan catatan cek email milik tempat itu (kalau tidak dipakai pencarian lain), cache domain email yang kedaluwarsa, statistik harian lebih dari 90 hari.
    * TIDAK PERNAH dibuang: tempat yang punya status atau catatan, pernah dikirimi email, ada di antrean, atau urutan follow-up, serta tempat yang websitenya belum dicek.
  Hasilnya tampil di Riwayat jalan dan di bagian Pembersihan data. Data yang dibuang tidak diarsipkan, tapi pencarian yang sama bisa diulang kapan saja (memakai kuota SerpApi).
