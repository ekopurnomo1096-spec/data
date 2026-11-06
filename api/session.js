// Otentikasi dan Manajemen Sesi.
// GET: Verifikasi status sesi | POST: Autentikasi masuk | DELETE: Logout
// Dilengkapi mekanisme perlindungan brute-force berbasis IP di Redis (hairleads:loginfail:<ip>, TTL 1 jam).
const { isAuthed, makeToken, cookieHeader, passwordOk, DAYS } = require("./_auth");
const { dbConfigured, cmd } = require("./_store");

const LOGINFAIL = "hairleads:loginfail:";
const MAX_FREE = 5;        // Toleransi percobaan sebelum throttling aktif
const BASE_LOCK = 5;       // Durasi penahanan awal (detik)
const MAX_LOCK = 15 * 60;  // Batas maksimal penahanan (15 menit)
const WINDOW = 3600;       // Jendela waktu pembersihan catatan kegagalan (1 jam)
const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };

function clientIp(req) {
  const xf = req.headers && req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}
// Mengembalikan sisa detik jika sedang dikunci, null jika tidak.
async function checkLock(ip) {
  if (!dbConfigured()) return null;
  try {
    const v = parse(await cmd(["GET", LOGINFAIL + ip]));
    if (v && v.until && v.until > Date.now()) return Math.ceil((v.until - Date.now()) / 1000);
  } catch (e) { /* Redis gagal: jangan sampai login malah macet total */ }
  return null;
}
async function recordFail(ip) {
  if (!dbConfigured()) return;
  try {
    const v = parse(await cmd(["GET", LOGINFAIL + ip])) || { n: 0 };
    const n = (v.n || 0) + 1;
    const until = n > MAX_FREE ? Date.now() + Math.min(BASE_LOCK * Math.pow(2, n - MAX_FREE - 1), MAX_LOCK) * 1000 : 0;
    await cmd(["SET", LOGINFAIL + ip, JSON.stringify({ n, until }), "EX", WINDOW]);
  } catch (e) { /* abaikan: lebih baik login sedikit kurang ketat daripada eror total */ }
}
async function recordSuccess(ip) {
  if (!dbConfigured()) return;
  try { await cmd(["DEL", LOGINFAIL + ip]); } catch (e) { /* abaikan */ }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const configured = !!process.env.APP_PASSWORD;
  if (req.method === "GET") return res.status(200).json({ authed: isAuthed(req), configured });
  if (req.method === "DELETE") {
    res.setHeader("Set-Cookie", cookieHeader("", 0));
    return res.status(200).json({ ok: true });
  }
  if (req.method === "POST") {
    if (!configured) return res.status(500).json({ error: "Environment variable APP_PASSWORD belum dikonfigurasi pada sistem." });
    const ip = clientIp(req);
    const lockedFor = await checkLock(ip);
    if (lockedFor) return res.status(429).json({ error: "Terlalu banyak percobaan gagal. Silakan coba kembali dalam " + lockedFor + " detik." });
    let b = req.body;
    if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    if (!b || !passwordOk(b.password || "")) {
      await recordFail(ip);
      await new Promise(r => setTimeout(r, 1000));
      return res.status(401).json({ error: "Kata sandi tidak valid" });
    }
    await recordSuccess(ip);
    res.setHeader("Set-Cookie", cookieHeader(makeToken(), DAYS * 86400));
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: "Metode HTTP tidak didukung" });
};
