// Kirim email lewat Resend (maksimal 20 per permintaan).
// GET  ?name=...            = {ready, from, subject, text}: status pengaturan (subject dan text kosong)
// GET  ?sent=1              = sama seperti di atas, ditambah {sent:{id:{t,to}}} (riwayat kirim) dan {daily:{used,limit}} (hitungan hari ini)
// POST {items:[{id,to,name,subject?,text?}], force?} = kirim. Subject dan text wajib diisi.
// Tempat yang sudah pernah dikirimi (hairleads:mail) dilewati kecuali force=true.
// Alamat di daftar suppression (berhenti berlangganan, bounce, spam) selalu dilewati, dengan atau tanpa force. Hasilnya ada di {suppressed:[id]}.
// Key Resend (nama "rs"), alamat pengirim ("rsf"), dan Reply-To opsional ("rrt") disimpan di Redis lewat Pengaturan; RESEND_API_KEY / RESEND_FROM di Vercel jadi cadangan.
// Pembungkus HTML, batas harian, dan pengirim batch ada di _mail.js (dipakai juga oleh kirim otomatis).
const { isAuthed } = require("./_auth");
const { dbConfigured, cmd, hgetall } = require("./_store");
const M = require("./_mail");

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "private, no-store");
    if (!isAuthed(req)) return res.status(401).json({ error: "Belum login" });
    const { key, from, replyTo, addr, srcn } = await M.config();

    if (req.method === "GET") {
      // Template email dikosongkan: subjek dan isi harus ditulis sendiri sebelum kirim
      const out = { ready: !!(key && from), hasKey: !!key, from, replyTo, addr, srcn, max: M.MAX, subject: "", text: "" };
      if (req.query && req.query.sent && dbConfigured()) {
        out.daily = { used: await M.usedToday(), limit: M.DAILY };
        const all = await hgetall(M.MAIL);
        out.sent = {};
        for (const k of Object.keys(all)) {
          try { const v = JSON.parse(all[k]); if (v && v.t) out.sent[k] = { t: v.t, to: String(v.to || ""), h: v.h ? 1 : 0 }; } catch (e) { /* abaikan baris rusak */ }
        }
      }
      return res.status(200).json(out);
    }
    if (req.method !== "POST") return res.status(405).json({ error: "metode tidak didukung" });

    // Hapus riwayat kirim: hanya disembunyikan dari tampilan (h:1). Status, catatan, dan catatan "sudah dikirimi" tetap, jadi tidak terkirim dobel
    if (req.body && (req.body.action === "clearhist" || (typeof req.body === "string" && /clearhist/.test(req.body)))) {
      if (!dbConfigured()) return res.status(200).json({ ok: true, hidden: [] });
      const all = await hgetall(M.MAIL), hidden = [], args = [];
      for (const k of Object.keys(all)) {
        try { const v = JSON.parse(all[k]); if (v && v.t && !v.h) { args.push(k, JSON.stringify({ t: v.t, to: String(v.to || ""), h: 1 })); hidden.push(k); } } catch (e) { /* abaikan baris rusak */ }
      }
      for (let i = 0; i < args.length; i += 200) await cmd(["HSET", M.MAIL, ...args.slice(i, i + 200)]);
      return res.status(200).json({ ok: true, hidden });
    }

    if (dbConfigured()) {
      let why = "";
      try { why = await M.checkHealth(); } catch (e) { /* abaikan */ }
      if (why) return res.status(423).json({ error: "Pengiriman sedang dijeda: " + why + ". Lanjutkan di tab Otomatis kalau sudah aman.", paused: true });
    }
    if (!key) return res.status(500).json({ error: "API key Resend belum diisi. Buka Pengaturan lalu masukkan key-nya" });
    if (!/@/.test(from)) return res.status(500).json({ error: "Alamat pengirim belum diisi. Buka Pengaturan lalu isi email pengirim (harus dari domain yang sudah diverifikasi di Resend)" });

    let b = req.body;
    if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    const list = Array.isArray(b.items) ? b.items : [];
    if (!list.length) return res.status(400).json({ error: "Tidak ada email untuk dikirim" });
    if (list.length > M.MAX) return res.status(400).json({ error: "Maksimal " + M.MAX + " email sekali kirim" });

    const bad = [], seenTo = new Set();
    let items = [];
    for (const o of list) {
      const id = String((o && o.id) || ""), to = M.clean(o && o.to, 200).toLowerCase();
      if (!M.ID.test(id) || !M.EMAIL.test(to) || seenTo.has(to)) { bad.push(id); continue; }
      seenTo.add(to);
      const subject = M.clean(o.subject, 200);
      const text = typeof o.text === "string" ? o.text.trim().slice(0, 5000) : "";
      if (!subject) return res.status(400).json({ error: "Subjek email masih kosong" });
      if (!text) return res.status(400).json({ error: "Isi email masih kosong" });
      items.push({ id, to, subject, text });
    }

    // Alamat yang sudah berhenti berlangganan / bounce / lapor spam tidak pernah dikirimi
    const suppressed = [];
    if (dbConfigured() && items.length) {
      const sup = await M.suppressedSet(items.map(i => i.to));
      items = items.filter(i => { if (sup.has(i.to)) { suppressed.push(i.id); return false; } return true; });
    }

    // Lewati yang sudah pernah dikirimi
    const skipped = [];
    if (!b.force && dbConfigured() && items.length) {
      const had = await cmd(["HMGET", M.MAIL, ...items.map(i => i.id)]);
      items = items.filter((i, k) => { if (had[k]) { skipped.push(i.id); return false; } return true; });
    }
    if (!items.length) return res.status(200).json({ sent: [], skipped, bad, suppressed });

    // Jangan melewati batas harian
    let used = await M.usedToday();
    if (M.DAILY > 0 && dbConfigured() && used + items.length > M.DAILY) {
      const left = Math.max(M.DAILY - used, 0);
      return res.status(400).json({ error: "Sisa kuota email hari ini " + left + " dari " + M.DAILY + ". Kurangi jumlah yang dipilih, atau tunggu reset jam 07.00 WIB.", daily: { used, limit: M.DAILY } });
    }

    await M.sendBatch({ key, from, replyTo, addr, srcn }, items, M.baseUrl(req));
    used = await M.recordSent(items, used);
    return res.status(200).json({ sent: items.map(i => i.id), skipped, bad, suppressed, daily: { used, limit: M.DAILY } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
