// Status prospek + catatan (per tempat) dan daftar pencarian tersimpan. Semua di Redis, berawalan "hairleads:".
const { isAuthed } = require("./_auth");
const { dbConfigured, cmd, hgetall } = require("./_store");
const { STATUSES, sanitizeLead } = require("./_leads");

const LEADS = "hairleads:leads", META = "hairleads:cmeta", CACHE = "hairleads:cache", AI = "hairleads:ai";
const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "private, no-store");
    if (!isAuthed(req)) return res.status(401).json({ error: "Belum login" });

    if (req.method === "GET") {
      if (!dbConfigured()) return res.status(200).json({ items: {}, searches: [], nodb: true });
      const part = String((req.query && req.query.part) || "");
      const out = {};
      if (part !== "items") {
        const m = await hgetall(META);
        out.searches = Object.keys(m).map(k => { const v = parse(m[k]); return v && { key: k, ...v }; })
          .filter(Boolean).sort((a, b) => b.at - a.at).slice(0, 40);
      }
      if (part !== "searches") {
        const l = await hgetall(LEADS);
        out.items = {};
        Object.keys(l).forEach(k => { const v = parse(l[k]); if (v) out.items[k] = v; });
      }
      return res.status(200).json(out);
    }

    if (req.method === "POST") {
      if (!dbConfigured()) return res.status(500).json({ error: "Database belum terhubung, jadi status dan catatan belum bisa disimpan. Hubungkan Upstash Redis di Vercel lalu Redeploy" });
      let b = req.body;
      if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
      b = b || {};

      if (b.action === "delsearch") {
        const key = String(b.key || "");
        if (!key || key.length > 300) return res.status(400).json({ error: "Kunci tidak valid" });
        // Skor AI tempat-tempat di pencarian ini ikut dihapus, kecuali yang sudah punya status atau catatan
        let aiRemoved = [];
        try {
          const raw = await cmd(["HGET", CACHE, key]);
          const c = raw ? parse(raw) : null;
          const ids = [...new Set(((c && c.results) || []).map(r => r && r.id).filter(id => typeof id === "string" && id))];
          if (ids.length) {
            const have = await cmd(["HMGET", LEADS, ...ids]);
            aiRemoved = ids.filter((id, i) => !have[i]);
            for (let i = 0; i < aiRemoved.length; i += 200) {
              await cmd(["HDEL", AI, ...aiRemoved.slice(i, i + 200)]);
            }
          }
        } catch (e) { aiRemoved = []; /* gagal bersih-bersih tidak boleh menggagalkan penghapusan */ }
        await cmd(["HDEL", CACHE, key]);
        await cmd(["HDEL", META, key]);
        return res.status(200).json({ ok: true, aiRemoved });
      }

      if (b.action === "save") {
        const id = String(b.id || "");
        if (!/^[\w:./|-]{1,120}$/.test(id)) return res.status(400).json({ error: "ID tempat tidak valid" });
        const s = STATUSES.includes(b.s) ? b.s : "";
        const n = String(b.n || "").slice(0, 2000);
        const lead = sanitizeLead(b.lead);
        lead.id = id;
        // Tidak ada status, catatan, atau hasil cari email: tidak perlu disimpan
        if (!s && !n && !lead.looked) {
          await cmd(["HDEL", LEADS, id]);
          return res.status(200).json({ ok: true, removed: true });
        }
        const rec = { s, n, t: Date.now(), lead };
        await cmd(["HSET", LEADS, id, JSON.stringify(rec)]);
        return res.status(200).json({ ok: true, t: rec.t });
      }
      return res.status(400).json({ error: "Aksi tidak dikenal" });
    }
    return res.status(405).json({ error: "metode tidak didukung" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
