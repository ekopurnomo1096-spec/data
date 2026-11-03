// GET = status key tersimpan (dimasking), POST = simpan ({serp, serp2, geo, gem}; "" = hapus, tidak dikirim = tidak diubah)
const { isAuthed } = require("./_auth");
const { dbConfigured, getKey, setKey, setActive } = require("./_store");

const NAMES = ["serp", "serp2", "geo", "gem"];
async function status() {
  const v = await Promise.all(NAMES.map(getKey));
  const o = {};
  NAMES.forEach((n, i) => { o[n] = hint(v[i]); });
  return o;
}
const hint = v => (v ? { set: true, hint: "…" + v.slice(-4) } : { set: false, hint: "" });

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (!isAuthed(req)) return res.status(401).json({ error: "Belum login" });
    if (!dbConfigured()) return res.status(500).json({ error: "Database belum terhubung. Di Vercel, buka tab Storage, hubungkan Upstash Redis ke project ini, lalu Redeploy" });
    if (req.method === "GET") {
      return res.status(200).json(await status());
    }
    if (req.method === "POST") {
      let b = req.body;
      if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
      b = b || {};
      for (const n of NAMES) {
        if (typeof b[n] === "string") {
          const v = b[n].trim();
          if (v.length > 300) return res.status(400).json({ error: "Key terlalu panjang" });
          await setKey(n, v);
        }
      }
      if (b.active === "1" || b.active === "2") await setActive(b.active);
      return res.status(200).json(await status());
    }
    return res.status(405).json({ error: "metode tidak didukung" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
