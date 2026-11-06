// Otomatisasi: pengaturan, antrean persetujuan, daftar suppression, log, dan penjalan pekerjaan. Logikanya ada di _jobs.js.
// GET                      = {cfg, queue, log, supp, searches, mail, flags}
// GET  ?a=cron             = dijalankan Vercel Cron setiap hari (header Authorization: Bearer CRON_SECRET), menjalankan semua pekerjaan
// POST {action:"cfg", cfg}               simpan pengaturan
// POST {action:"scoretest", cfg}          uji bobot skor dan batas (belum disimpan) pada prospek yang ada
// POST {action:"approve", ids?|all?}     setujui prospek di antrean (all = semua yang menunggu)
// POST {action:"reject", ids}            tolak (tidak akan diantrekan lagi)
// POST {action:"run", job}               jalankan sekarang: "all" | "mail" | "refresh" | "rotate" | "enrich"
// POST {action:"digest"}                    kirim tes ringkasan harian ke email penerima laporan
// POST {action:"suppadd", email} / {action:"suppdel", email}   kelola daftar berhenti
const crypto = require("crypto");
const { isAuthed } = require("./_auth");
const { dbConfigured, cmd, hgetall } = require("./_store");
const M = require("./_mail");
const J = require("./_jobs");
const SC = require("./_score");
const scoreDefs = SC.KEYS.map(k => ({ k, d: SC.DEFS[k][0], l: SC.DEFS[k][1], g: SC.DEFS[k][2] }));

const META = "hairleads:cmeta";
const parse = M.parse;

function cronOk(req) {
  const s = process.env.CRON_SECRET;
  if (!s) return false;
  const a = Buffer.from(String((req.headers && req.headers.authorization) || "")), b = Buffer.from("Bearer " + s);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function state(req) {
  const cfg = await J.getCfg();
  const out = { cfg, scoreDefs, queue: [], log: [], supp: { n: 0, list: [] }, searches: [], flags: {} };
  const rc = await M.config();
  out.mail = { ready: !!(rc.key && /@/.test(rc.from)), addr: !!rc.addr, used: await M.usedToday(), limit: M.DAILY };
  out.pause = await M.getPause();
  try { out.running = (await cmd(["EXISTS", J.LOCK])) === 1; } catch (e) { out.running = false; }
  out.warm = await J.warmInfo(cfg);
  out.stats = await M.getStats(14);
  out.flags = { cron: !!process.env.CRON_SECRET, webhook: !!process.env.RESEND_WEBHOOK_SECRET, publicUrl: M.baseUrl(req) };
  const q = await hgetall(J.QUEUE);
  // Antrean hanya untuk alamat Gmail, Yahoo, dll (sama dengan tab Email). Yang berdomain sendiri dibuang dari antrean saat halaman dibuka.
  // Yang berstatus ditolak tetap disimpan supaya tidak diantrekan lagi.
  try {
    const bad = Object.keys(q).filter(k => { const v = parse(q[k]); return v && (v.st === "pending" || v.st === "ok") && !SC.FREE.test(String(v.to || "").toLowerCase()); });
    for (let i = 0; i < bad.length; i += 200) await cmd(["HDEL", J.QUEUE, ...bad.slice(i, i + 200)]);
    bad.forEach(k => { delete q[k]; });
  } catch (e) { /* gagal membersihkan tidak boleh menggagalkan halaman */ }
  out.queue = Object.keys(q).map(k => parse(q[k])).filter(Boolean).filter(v => v.st === "pending" || v.st === "ok")
    .sort((a, b) => (a.st === b.st ? b.sc - a.sc : a.st === "pending" ? -1 : 1)).slice(0, 200);
  try { // foto tempat untuk daftar antrean (diambil dari hasil pencarian tersimpan)
    if (out.queue.length) {
      const d = await J.loadData();
      out.queue.forEach(v => { const x = d.map.get(v.id); if (x && x.thumbnail) v.thumbnail = x.thumbnail; });
    }
  } catch (e) { /* tanpa foto kalau gagal, daftar tetap tampil */ }
  out.counts = { pending: 0, ok: 0, no: 0 };
  Object.keys(q).forEach(k => { const v = parse(q[k]); if (v && out.counts[v.st] != null) out.counts[v.st]++; });
  const seq = await hgetall(J.SEQ);
  const steps = cfg.mail.steps.length;
  out.seq = { active: 0, done: 0 };
  Object.keys(seq).forEach(k => { const v = parse(seq[k]); if (v) (v.n >= steps ? out.seq.done++ : out.seq.active++); });
  out.log = (await J.getLog()).slice(0, 10);
  try { out.clean = M.parse(await cmd(["HGET", J.AUTO, "pruned"])); } catch (e) { out.clean = null; }
  try { const nt = await M.notifyTarget(); out.notify = { to: nt.to }; } catch (e) { out.notify = { to: "" }; }
  try { out.dry = parse(await cmd(["HGET", J.AUTO, "dry"])) || {}; } catch (e) { out.dry = {}; }
  try { const ri = await J.rotInfo(cfg); out.rot = { total: ri.total, left: ri.left, next: ri.todo.slice(0, 3).map(x => x.city + " · " + x.kind) }; } catch (e) { out.rot = null; }
  const sp = await hgetall(M.SUPP);
  const sl = Object.keys(sp).map(e => ({ e, ...(parse(sp[e]) || {}) })).sort((a, b) => (b.t || 0) - (a.t || 0));
  out.supp = { n: sl.length, list: sl.slice(0, 100) };
  const meta = await hgetall(META);
  out.searches = Object.keys(meta).map(k => { const v = parse(meta[k]); return v && { key: k, city: v.city, kind: v.kind, source: v.source, n: v.n, at: v.at }; })
    .filter(Boolean).sort((a, b) => b.at - a.at).slice(0, 60);
  return out;
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "private, no-store");
    const a = String((req.query && req.query.a) || "");

    if (a === "cron") {
      if (!cronOk(req)) return res.status(401).json({ error: "CRON_SECRET belum diisi di Vercel, atau tidak cocok" });
      const r = await J.runAuto({ jobs: "all", src: "cron", base: M.baseUrl(req) });
      return res.status(r.error && !r.jobs && !r.paused ? 500 : 200).json(r);
    }

    if (!isAuthed(req)) return res.status(401).json({ error: "Belum login" });
    if (!dbConfigured()) return res.status(200).json({ nodb: true, cfg: J.defaultCfg(), scoreDefs, queue: [], log: [], supp: { n: 0, list: [] }, searches: [], flags: {}, mail: {}, counts: {}, seq: {} });

    if (req.method === "GET") return res.status(200).json(await state(req));
    if (req.method !== "POST") return res.status(405).json({ error: "metode tidak didukung" });

    let b = req.body;
    if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    const ids = Array.isArray(b.ids) ? b.ids.map(String).filter(i => M.ID.test(i)).slice(0, 500) : [];

    if (b.action === "cfg") {
      const cfg = await J.setCfg(b.cfg);
      return res.status(200).json({ ok: true, cfg });
    }
    if (b.action === "why") { // alasan tiap tempat ber-email belum masuk antrean (hanya baca)
      return res.status(200).json({ ok: true, why: await J.queueWhy(ids.length ? ids : null) });
    }
    if (b.action === "scoretest") { // uji bobot skor tanpa menyimpan
      return res.status(200).json({ ok: true, ...(await J.scorePreview(b.cfg)) });
    }
    if (b.action === "approve" || b.action === "reject") {
      const q = await hgetall(J.QUEUE), args = [];
      const pick = b.action === "approve" && b.all ? Object.keys(q).filter(k => (parse(q[k]) || {}).st === "pending") : ids;
      let n = 0;
      for (const id of pick) {
        const v = parse(q[id] || "null");
        if (!v || v.st !== "pending") continue;
        args.push(id, JSON.stringify({ ...v, st: b.action === "approve" ? "ok" : "no" }));
        n++;
      }
      for (let i = 0; i < args.length; i += 200) await cmd(["HSET", J.QUEUE, ...args.slice(i, i + 200)]);
      return res.status(200).json({ ok: true, n });
    }
    if (b.action === "nextcity") { // kota baru berikutnya dari daftar putaran kota, untuk pencarian manual
      const kind = ["salon", "wig", "beauty"].includes(b.kind) ? b.kind : "salon", source = b.source === "osm" ? "osm" : "google";
      const r = await J.nextCity(await J.getCfg(), kind, source);
      return res.status(200).json(r);
    }
    if (b.action === "run") {
      const job = ["all", "mail", "refresh", "rotate", "enrich", "queue", "intake"].includes(b.job) ? b.job : "all";
      const r = await J.runAuto({ jobs: job, src: "manual", base: M.baseUrl(req) });
      return res.status(r.error && !r.jobs && !r.paused ? 409 : 200).json(r);
    }
    if (b.action === "digest") { // kirim tes ringkasan harian sekarang
      try {
        const r = await J.sendDigest(await J.getCfg(), M.baseUrl(req), true);
        if (!r.sent) return res.status(400).json({ error: "Tidak terkirim: " + (r.skip || "tanpa penerima") });
        return res.status(200).json({ ok: true, to: r.to });
      } catch (e) { return res.status(400).json({ error: e.message }); }
    }
    if (b.action === "pause") {
      if (b.on) await M.setPause("Dijeda manual", false); else await M.clearPause();
      return res.status(200).json({ ok: true, pause: await M.getPause() });
    }
    if (b.action === "suppadd") {
      const e = String(b.email || "").trim().toLowerCase();
      if (!M.EMAIL.test(e)) return res.status(400).json({ error: "Alamat email tidak valid" });
      await M.suppress(e, "manual");
      return res.status(200).json({ ok: true });
    }
    if (b.action === "suppdel") {
      const e = String(b.email || "").trim().toLowerCase();
      if (!e) return res.status(400).json({ error: "Alamat email kosong" });
      await cmd(["HDEL", M.SUPP, e]);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: "Aksi tidak dikenal" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
