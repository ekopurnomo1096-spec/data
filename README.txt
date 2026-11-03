CARA PASANG (sekali saja)
Di Vercel: Project > Settings > Environment Variables, tambahkan SATU variabel saja:

  APP_PASSWORD = kata sandi untuk masuk ke halaman ini (pilih yang panjang dan unik)

Centang Production, Preview, Development. Lalu Deployments > titik tiga di deploy terbaru > Redeploy.

API key TIDAK perlu ditaruh di Vercel. Setelah masuk, klik "Pengaturan" di halaman dan isi:
  - SerpApi (serpapi.com)    untuk sumber "Google Maps"
  - Geoapify (geoapify.com)  opsional, untuk sumber "OpenStreetMap"
Key disimpan di browser tiap perangkat, jadi isi sekali di setiap perangkat yang dipakai.

(Opsional) Kalau SERPAPI_KEY / GEOAPIFY_KEY sudah ada di Vercel, itu dipakai sebagai cadangan
bila Pengaturan di browser kosong. Hapus keduanya dari Vercel kalau mau semuanya hanya di browser.
JANGAN menaruh API key atau kata sandi di index.html atau di GitHub.
