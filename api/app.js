// Gerbang halaman. Halaman aplikasi (dulu index.html) sekarang dikirim dari sini, HANYA kalau alamat
// yang diminta cocok dengan LOGIN_PATH di Vercel. Tanpa tahu LOGIN_PATH, situs ini langsung dialihkan
// ke https://emahairshop.com/ dari luar - orang lain yang buka domainnya langsung tidak akan nemu form login sama sekali.
//
// Isi di Vercel: Settings > Environment Variables > LOGIN_PATH = teks rahasia, bebas, tanpa garis
// miring (contoh: masuk-x7q2). Centang Production, Preview, Development, lalu Redeploy.
// Setelah itu alamat masuknya jadi: https://domainmu.com/masuk-x7q2
//
// Setelah login, alamat di browser otomatis jadi "/" (tanpa LOGIN_PATH). Kalau sudah login, "/" langsung
// membuka aplikasi; kalau belum login atau sudah keluar, "/" dialihkan ke https://emahairshop.com/.
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
const HOME = "https://emahairshop.com/";
const norm = s => String(s || "").trim().replace(/^\/+|\/+$/g, "");

module.exports = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const want = norm(process.env.LOGIN_PATH);
  const got = norm(String(req.url || "/").split("?")[0]);
  // Sudah login (cookie sesi valid): halaman dikirim di alamat mana pun, jadi setelah masuk alamatnya bisa
  // dibersihkan jadi "/" (lihat showApp di _app.html). Belum login: hanya LOGIN_PATH yang menampilkan halaman.
  const authed = isAuthed(req);
  if (!authed && (!want || got !== want)) {
    // Bukan LOGIN_PATH dan belum login: arahkan ke situs utama, bukan 404. Pakai 302 (sementara), bukan 301,
    // supaya browser tidak menyimpan pengalihan ini permanen. Tidak membedakan "LOGIN_PATH belum diisi" dengan
    // "alamat salah", jadi tidak ada petunjuk buat orang yang cuma coba-coba alamat.
    res.setHeader("Location", HOME);
    res.status(302).send("");
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(appHtml());
};
