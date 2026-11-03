// GET = status key tersimpan (dimasking), POST = simpan ({serp, geo}; "" = hapus, tidak dikirim = tidak diubah)
const { isAuthed } = require("./_auth");
const { dbConfigured, getKey, setKey } = require("./_store");

const hint = v => (v ? { set: true, hint: "…" + v.slice(-4) } : { set: false, hint: "" });

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (!isAuthed(req)) return res.status(401).json({ error: "Belum login" });
    if (!dbConfigured()) return res.status(500).json({ error: "Database belum terhubung. Di Vercel, buka tab Storage, hubungkan Upstash Redis ke project ini, lalu Redeploy" });
    if (req.method === "GET") {
      const [s, g] = await Promise.all([getKey("serp"), getKey("geo")]);
      return res.status(200).json({ serp: hint(s), geo: hint(g) });
    }
    if (req.method === "POST") {
      let b = req.body;
      if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
      b = b || {};
      for (const n of ["serp", "geo"]) {
        if (typeof b[n] === "string") {
          const v = b[n].trim();
          if (v.length > 300) return res.status(400).json({ error: "Key terlalu panjang" });
          await setKey(n, v);
        }
      }
      const [s, g] = await Promise.all([getKey("serp"), getKey("geo")]);
      return res.status(200).json({ serp: hint(s), geo: hint(g) });
    }
    return res.status(405).json({ error: "metode tidak didukung" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
