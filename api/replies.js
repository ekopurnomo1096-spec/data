// Balasan masuk yang sudah dibaca AI (lihat _reply.js). Perlu login.
// GET                                   = {items:[...], cfg:{inbound, secret, webhook}}
// POST {action:"analyze", from, subject, text}   tempel balasan manual (mis. dari Gmail), dibaca dan diterapkan seperti balasan masuk
// POST {action:"done", rid, on}          tandai sudah ditindaklanjuti / belum
// POST {action:"del", rid}               hapus dari daftar (status prospek tidak berubah)
const { isAuthed } = require("./_auth");
const { dbConfigured, cmd } = require("./_store");
const M = require("./_mail");
const R = require("./_reply");

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "private, no-store");
    if (!isAuthed(req)) return res.status(401).json({ error: "Belum login" });
    if (!dbConfigured()) return res.status(200).json({ nodb: true, items: [], cfg: {} });
    const cfg = { webhook: !!process.env.RESEND_WEBHOOK_SECRET, inbound: !!process.env.INBOUND_SECRET, base: M.baseUrl(req) };

    if (req.method === "GET") return res.status(200).json({ items: await R.listReplies(100), cfg });
    if (req.method !== "POST") return res.status(405).json({ error: "metode tidak didukung" });

    let b = req.body;
    if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    const rid = String(b.rid || "");

    if (b.action === "analyze") {
      const text = typeof b.text === "string" ? b.text.trim().slice(0, 20000) : "";
      if (!text) return res.status(400).json({ error: "Tempel isi balasan dulu" });
      const from = String(b.from || "").trim();
      if (!M.EMAIL.test(R.parseFrom(from).email)) return res.status(400).json({ error: "Isi alamat email pengirim balasan" });
      const out = await R.processReply({ from, subject: b.subject, text, mid: "", src: "manual" });
      if (out.dup) return res.status(200).json({ ok: true, dup: true });
      if (!out.reply) return res.status(400).json({ error: out.skip || "Balasan tidak bisa dibaca" });
      return res.status(200).json({ ok: true, reply: { rid: out.id, ...out.reply } });
    }
    if (b.action === "done" || b.action === "del") {
      if (!/^[\w:.@<>-]{1,120}$/.test(rid)) return res.status(400).json({ error: "ID tidak valid" });
      if (b.action === "del") { await cmd(["HDEL", R.REPLIES, rid]); return res.status(200).json({ ok: true }); }
      const v = M.parse(await cmd(["HGET", R.REPLIES, rid]));
      if (!v) return res.status(404).json({ error: "Balasan tidak ditemukan" });
      v.done = !!b.on;
      await cmd(["HSET", R.REPLIES, rid, JSON.stringify(v)]);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: "Aksi tidak dikenal" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
