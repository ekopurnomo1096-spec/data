// Kirim email lewat Resend (maksimal 20 per permintaan).
// GET  ?name=...            = {ready, from, subject, text}: status pengaturan + contoh isi email dari template
// GET  ?sent=1              = sama seperti di atas, ditambah {sent:{id:{t,to}}} (riwayat kirim dari hairleads:mail)
// POST {items:[{id,to,name,subject?,text?}], force?} = kirim. Tanpa subject/text dipakai template.
// Tempat yang sudah pernah dikirimi (hairleads:mail) dilewati kecuali force=true.
// Key Resend (nama "rs"), alamat pengirim ("rsf"), dan Reply-To opsional ("rrt") disimpan di Redis lewat Pengaturan; RESEND_API_KEY / RESEND_FROM di Vercel jadi cadangan.
const { isAuthed } = require("./_auth");
const { dbConfigured, getKey, cmd, hgetall } = require("./_store");
const { TEMPLATE } = require("./_template");

const MAIL = "hairleads:mail";
const MAX = 20;
const SUBJECT = "Human hair extension supplier from Indonesia (wholesale)";
const FOOTER = "\n\n--\nIf you'd rather not hear from us, just reply \"unsubscribe\" and we won't email you again.";
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[A-Za-z]{2,}$/;
const ID = /^[\w:./|-]{1,120}$/;

const clean = (v, n) => String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").replace(/[<>]/g, "").trim().slice(0, n);
function compose(name) {
  const n = clean(name, 80);
  const text = TEMPLATE.replace(/^Hi!/, n ? "Hi " + n + " team!" : "Hi!") + FOOTER;
  return { subject: SUBJECT, text };
}
async function config() {
  const key = (await getKey("rs")) || process.env.RESEND_API_KEY || "";
  const from = (await getKey("rsf")) || process.env.RESEND_FROM || "";
  const rt = ((await getKey("rrt")) || process.env.RESEND_REPLY_TO || "").trim();
  return { key, from, replyTo: EMAIL.test(rt) || /<[^<>@\s]+@[^<>\s]+>$/.test(rt) ? rt : "" };
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "private, no-store");
    if (!isAuthed(req)) return res.status(401).json({ error: "Belum login" });
    const { key, from, replyTo } = await config();

    if (req.method === "GET") {
      const out = { ready: !!(key && from), hasKey: !!key, from, replyTo, max: MAX, ...compose(req.query && req.query.name) };
      if (req.query && req.query.sent && dbConfigured()) {
        const all = await hgetall(MAIL);
        out.sent = {};
        for (const k of Object.keys(all)) {
          try { const v = JSON.parse(all[k]); if (v && v.t) out.sent[k] = { t: v.t, to: String(v.to || "") }; } catch (e) { /* abaikan baris rusak */ }
        }
      }
      return res.status(200).json(out);
    }
    if (req.method !== "POST") return res.status(405).json({ error: "metode tidak didukung" });

    if (!key) return res.status(500).json({ error: "API key Resend belum diisi. Buka Pengaturan lalu masukkan key-nya" });
    if (!/@/.test(from)) return res.status(500).json({ error: "Alamat pengirim belum diisi. Buka Pengaturan lalu isi email pengirim (harus dari domain yang sudah diverifikasi di Resend)" });

    let b = req.body;
    if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    const list = Array.isArray(b.items) ? b.items : [];
    if (!list.length) return res.status(400).json({ error: "Tidak ada email untuk dikirim" });
    if (list.length > MAX) return res.status(400).json({ error: "Maksimal " + MAX + " email sekali kirim" });

    const bad = [], seenTo = new Set();
    let items = [];
    for (const o of list) {
      const id = String((o && o.id) || ""), to = clean(o && o.to, 200).toLowerCase();
      if (!ID.test(id) || !EMAIL.test(to) || seenTo.has(to)) { bad.push(id); continue; }
      seenTo.add(to);
      const d = compose(o.name);
      const subject = clean(o.subject, 200) || d.subject;
      const text = typeof o.text === "string" && o.text.trim() ? o.text.slice(0, 5000) : d.text;
      items.push({ id, to, subject, text });
    }

    // Lewati yang sudah pernah dikirimi
    const skipped = [];
    if (!b.force && dbConfigured() && items.length) {
      const had = await cmd(["HMGET", MAIL, ...items.map(i => i.id)]);
      items = items.filter((i, k) => { if (had[k]) { skipped.push(i.id); return false; } return true; });
    }
    if (!items.length) return res.status(200).json({ sent: [], skipped, bad });

    const r = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(items.map(i => ({ from, to: [i.to], subject: i.subject, text: i.text, ...(replyTo ? { reply_to: replyTo } : {}) }))),
      signal: AbortSignal.timeout(25000)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const m = String(j.message || j.error || r.status);
      if (r.status === 401 || r.status === 403 && /api key/i.test(m)) throw new Error("API key Resend tidak valid. Periksa lagi di Pengaturan");
      if (/domain|verif/i.test(m)) throw new Error("Domain pengirim belum diverifikasi di Resend, atau alamat pengirim tidak sesuai domainnya. Cek di dashboard Resend (" + m + ")");
      if (r.status === 429) throw new Error("Terlalu cepat atau kuota Resend habis. Tunggu sebentar lalu coba lagi");
      throw new Error("Resend: " + m);
    }
    const t = Date.now();
    if (dbConfigured()) {
      for (const i of items) {
        try { await cmd(["HSET", MAIL, i.id, JSON.stringify({ t, to: i.to })]); } catch (e) { /* gagal catat tidak boleh menggagalkan hasil */ }
      }
    }
    return res.status(200).json({ sent: items.map(i => i.id), skipped, bad });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
