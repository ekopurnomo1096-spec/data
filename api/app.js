// Gerbang halaman. Halaman aplikasi (dulu index.html) sekarang dikirim dari sini, HANYA kalau alamat
// yang diminta cocok dengan LOGIN_PATH di Vercel. Tanpa tahu LOGIN_PATH, situs ini menampilkan halaman 404
// (api/_404.html) dari luar - orang lain yang buka domainnya langsung tidak akan nemu form login sama sekali.
//
// Isi di Vercel: Settings > Environment Variables > LOGIN_PATH = teks rahasia, bebas, tanpa garis
// miring (contoh: masuk-x7q2). Centang Production, Preview, Development, lalu Redeploy.
// Setelah itu alamat masuknya jadi: https://domainmu.com/masuk-x7q2
//
// Setelah login, alamat di browser otomatis jadi "/" (tanpa LOGIN_PATH). Kalau sudah login, "/" langsung
// membuka aplikasi; kalau belum login atau sudah keluar, "/" menampilkan halaman 404.
//
// Ganti LOGIN_PATH kapan saja kalau alamatnya kebagi ke orang yang salah - sesi yang sudah login
// (cookie) tetap jalan seperti biasa, cuma alamat untuk pertama kali masuk yang berubah.
const fs = require("fs");
const path = require("path");
const { isAuthed } = require("./_auth");

let HTML = null;
function appHtml() {
  if (!HTML) HTML = fs.readFileSync(path.join(__dirname, "_app.html"), "utf8");
  return HTML;
}
let NF = null;
function notFoundHtml() {
  if (!NF) NF = fs.readFileSync(path.join(__dirname, "_404.html"), "utf8");
  return NF;
}
const norm = s => String(s || "").trim().replace(/^\/+|\/+$/g, "");

module.exports = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const want = norm(process.env.LOGIN_PATH);
  const got = norm(String(req.url || "/").split("?")[0]);
  // Sudah login (cookie sesi valid): halaman dikirim di alamat mana pun, jadi setelah masuk alamatnya bisa
  // dibersihkan jadi "/" (lihat showApp di _app.html). Belum login: hanya LOGIN_PATH yang menampilkan halaman.
  const authed = isAuthed(req);
  if (!authed && (!want || got !== want)) {
    // Bukan LOGIN_PATH dan belum login: tampilkan halaman 404 buatan sendiri (api/_404.html) dengan status 404 asli.
    // Tidak membedakan "LOGIN_PATH belum diisi" dengan "alamat salah", jadi tidak ada petunjuk buat orang yang
    // cuma coba-coba alamat.
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(404).send(notFoundHtml());
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(appHtml());
};
