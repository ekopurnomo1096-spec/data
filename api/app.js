// Gerbang halaman. Halaman aplikasi (dulu index.html) sekarang dikirim dari sini, HANYA kalau alamat
// yang diminta cocok dengan LOGIN_PATH di Vercel. Tanpa tahu LOGIN_PATH, situs ini terlihat kosong
// (404) dari luar - orang lain yang buka domainnya langsung tidak akan nemu form login sama sekali.
//
// Isi di Vercel: Settings > Environment Variables > LOGIN_PATH = teks rahasia, bebas, tanpa garis
// miring (contoh: masuk-x7q2). Centang Production, Preview, Development, lalu Redeploy.
// Setelah itu alamat masuknya jadi: https://domainmu.com/masuk-x7q2
//
// Ganti LOGIN_PATH kapan saja kalau alamatnya kebagi ke orang yang salah - sesi yang sudah login
// (cookie) tetap jalan seperti biasa, cuma alamat untuk pertama kali masuk yang berubah.
const fs = require("fs");
const path = require("path");

let HTML = null;
function appHtml() {
  if (!HTML) HTML = fs.readFileSync(path.join(__dirname, "_app.html"), "utf8");
  return HTML;
}
const norm = s => String(s || "").trim().replace(/^\/+|\/+$/g, "");

module.exports = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const want = norm(process.env.LOGIN_PATH);
  const got = norm(String(req.url || "/").split("?")[0]);
  if (!want || got !== want) {
    // Sengaja dibuat polos: tidak membedakan "belum diisi di Vercel" dengan "alamat salah",
    // supaya tidak ada petunjuk buat orang yang cuma coba-coba alamat.
    res.status(404).send("Not found");
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(appHtml());
};
