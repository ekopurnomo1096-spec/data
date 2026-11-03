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
