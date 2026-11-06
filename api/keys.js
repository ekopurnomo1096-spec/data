// Manajemen Kunci API dan Konfigurasi Pengirim (Tersimpan terenkripsi di Upstash Redis).
// GET: Status keberadaan kunci (dimasking) | POST: Pembaruan atau penghapusan kunci API.
const { isAuthed } = require("./_auth");
const { dbConfigured, getKey, setKey, setActive } = require("./_store");

const NAMES = ["serp", "serp2", "geo", "gem", "rs", "rsf", "rrt", "addr", "srcn"];
async function status() {
  const v = await Promise.all(NAMES.map(getKey));
  const o = {};
  NAMES.forEach((n, i) => { o[n] = hint(v[i], n === "rsf" || n === "rrt" || n === "addr" || n === "srcn"); });
  return o;
}
const hint = (v, full) => (v ? { set: true, hint: full ? v : "…" + v.slice(-4) } : { set: false, hint: "" });

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (!isAuthed(req)) return res.status(401).json({ error: "Otorisasi diperlukan. Silakan masuk terlebih dahulu." });
    if (!dbConfigured()) return res.status(500).json({ error: "Database belum terhubung. Pastikan koneksi Upstash Redis telah dikonfigurasi." });
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
          if (v.length > 300) return res.status(400).json({ error: "Nilai kunci melebihi batas maksimal (300 karakter)." });
          await setKey(n, v);
        }
      }
      if (b.active === "1" || b.active === "2") await setActive(b.active);
      return res.status(200).json(await status());
    }
    return res.status(405).json({ error: "Metode HTTP tidak didukung" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
