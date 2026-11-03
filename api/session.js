// GET = cek status login, POST = masuk, DELETE = keluar
const { isAuthed, makeToken, cookieHeader, passwordOk, DAYS } = require("./_auth");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const configured = !!process.env.APP_PASSWORD;
  if (req.method === "GET") return res.status(200).json({ authed: isAuthed(req), configured });
  if (req.method === "DELETE") {
    res.setHeader("Set-Cookie", cookieHeader("", 0));
    return res.status(200).json({ ok: true });
  }
  if (req.method === "POST") {
    if (!configured) return res.status(500).json({ error: "APP_PASSWORD belum diisi di Vercel (Settings > Environment Variables), lalu Redeploy" });
    let b = req.body;
    if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    if (!b || !passwordOk(b.password || "")) {
      await new Promise(r => setTimeout(r, 1000));
      return res.status(401).json({ error: "Kata sandi salah" });
    }
    res.setHeader("Set-Cookie", cookieHeader(makeToken(), DAYS * 86400));
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: "metode tidak didukung" });
};
