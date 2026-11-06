// Application Gateway. Mengontrol akses aplikasi berdasarkan konfigurasi LOGIN_PATH.
// Halaman utama aplikasi hanya di-render apabila request sesuai dengan LOGIN_PATH yang ditentukan,
// atau jika pengguna telah memiliki sesi otentikasi yang valid.
//
// Konfigurasi Environment Variable di Vercel:
// Settings > Environment Variables > LOGIN_PATH = [path-rahasia] (contoh: portal-auth-9x)
// Pastikan memilih target: Production, Preview, dan Development, lalu lakukan Redeploy.
// URL akses pertama: https://domainanda.com/[LOGIN_PATH]
//
// Setelah otentikasi berhasil, URL browser akan dibersihkan menjadi "/" (root path).
// Apabila belum terotentikasi dan mengakses path selain LOGIN_PATH, sistem mengembalikan halaman 404
// untuk melindungi antarmuka login dari scanning atau akses pihak tidak berwenang.
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
  // Sesi aktif: sajikan aplikasi pada path mana pun.
  // Sesi belum aktif: batasi akses hanya melalui LOGIN_PATH yang terkonfigurasi.
  const authed = isAuthed(req);
  if (!authed && (!want || got !== want)) {
    // Kembalikan 404 buatan untuk menyembunyikan eksistensi portal dari pemindaian publik
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(404).send(notFoundHtml());
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(appHtml());
};
