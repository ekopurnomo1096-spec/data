// Kirim email lewat Resend (maksimal 20 per permintaan).
// GET  ?name=...            = {ready, from, subject, text}: status pengaturan (subject dan text kosong)
// GET  ?sent=1              = sama seperti di atas, ditambah {sent:{id:{t,to}}} (riwayat kirim) dan {daily:{used,limit}} (hitungan hari ini)
// POST {items:[{id,to,name,subject?,text?}], force?} = kirim. Subject dan text wajib diisi.
// Tempat yang sudah pernah dikirimi (hairleads:mail) dilewati kecuali force=true.
// Key Resend (nama "rs"), alamat pengirim ("rsf"), dan Reply-To opsional ("rrt") disimpan di Redis lewat Pengaturan; RESEND_API_KEY / RESEND_FROM di Vercel jadi cadangan.
const { isAuthed } = require("./_auth");
const { dbConfigured, getKey, cmd, hgetall } = require("./_store");
const { BRAND } = require("./_template");

const MAIL = "hairleads:mail";
const DAYK = "hairleads:mailday"; // hitungan email terkirim per hari (UTC), field = "YYYY-MM-DD"
const MAX = 20;
// Batas harian. Akun gratis Resend 100 email per hari (reset tengah malam UTC = 07.00 WIB).
// Ganti lewat RESEND_DAILY_LIMIT di Vercel. Isi 0 kalau akun berbayar tanpa batas harian.
const DAILY = (() => { const v = process.env.RESEND_DAILY_LIMIT; if (v === undefined || v === "") return 100; const n = parseInt(v, 10); return n >= 0 ? n : 100; })();
const today = () => new Date().toISOString().slice(0, 10);
async function usedToday() {
  if (!dbConfigured()) return 0;
  try { return parseInt(await cmd(["HGET", DAYK, today()]), 10) || 0; } catch (e) { return 0; }
}
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[A-Za-z]{2,}$/;
const ID = /^[\w:./|-]{1,120}$/;

const clean = (v, n) => String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").replace(/[<>]/g, "").trim().slice(0, n);

// Bungkus isi email polos (text) jadi HTML rapi dengan header dan footer brand, supaya
// email tidak terasa seperti pesan WA yang disalin-tempel. Paragraf dipisah baris kosong;
// baris yang diawali "•" atau "-" otomatis jadi daftar bertitik.
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Kalau satu paragraf terlalu panjang (banyak kalimat jadi satu blok), pecah otomatis
// setiap 2 kalimat jadi paragraf sendiri supaya tidak terasa seperti satu kalimat raksasa.
function splitLong(line) {
  if (line.length <= 200) return [line];
  const sentences = (line.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [line]).map(s => s.trim()).filter(Boolean);
  if (sentences.length < 3) return [line];
  const paras = [];
  for (let i = 0; i < sentences.length; i += 2) paras.push(sentences.slice(i, i + 2).join(" "));
  return paras;
}
function textToHtmlBody(text) {
  const lines = String(text || "").split(/\n/);
  let html = "", inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { if (inList) { html += "</ul>"; inList = false; } continue; }
    if (/^[•-]\s+/.test(line)) {
      if (!inList) { html += '<ul style="margin:0 0 14px;padding-left:20px">'; inList = true; }
      html += '<li style="margin:0 0 6px">' + escHtml(line.replace(/^[•-]\s+/, "")) + "</li>";
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      for (const p of splitLong(line)) html += '<p style="margin:0 0 14px">' + escHtml(p) + "</p>";
    }
  }
  if (inList) html += "</ul>";
  return html || '<p style="margin:0"></p>';
}
function buildHtml(text) {
  const siteLabel = escHtml(BRAND.website.replace(/^https?:\/\//, "").replace(/\/$/, ""));
  return '<!doctype html><html><body style="margin:0;padding:0;background:#f3efe7;font-family:Arial,Helvetica,sans-serif">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3efe7;padding:24px 0"><tr><td align="center">' +
    '<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden" cellpadding="0" cellspacing="0"><tr><td>' +
    '<div style="background:#000000;padding:22px 28px">' +
    '<span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.02em">' + escHtml(BRAND.name) + "</span></div>" +
    '<div style="padding:28px;color:#2a2a2a;font-size:15px;line-height:1.55">' + textToHtmlBody(text) + "</div>" +
    '<div style="padding:18px 28px;background:#f6f3ec;border-top:1px solid #e7e1d4;font-size:12.5px;color:#4a4a4a">' +
    "<div style=\"margin-bottom:6px\"><b>" + escHtml(BRAND.name) + "</b> — " + escHtml(BRAND.tagline) + "</div>" +
    "<div>Website: <a href=\"" + escHtml(BRAND.website) + "\" style=\"color:#000000;text-decoration:underline\">" + siteLabel + "</a></div></div>" +
    "</td></tr></table></td></tr></table></body></html>";
}
// Template email dikosongkan: subjek dan isi harus ditulis sendiri sebelum kirim
function compose() {
  return { subject: "", text: "" };
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
      const out = { ready: !!(key && from), hasKey: !!key, from, replyTo, max: MAX, ...compose() };
      if (req.query && req.query.sent && dbConfigured()) {
        out.daily = { used: await usedToday(), limit: DAILY };
        const all = await hgetall(MAIL);
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
      const all = await hgetall(MAIL), hidden = [], args = [];
      for (const k of Object.keys(all)) {
        try { const v = JSON.parse(all[k]); if (v && v.t && !v.h) { args.push(k, JSON.stringify({ t: v.t, to: String(v.to || ""), h: 1 })); hidden.push(k); } } catch (e) { /* abaikan baris rusak */ }
      }
      for (let i = 0; i < args.length; i += 200) await cmd(["HSET", MAIL, ...args.slice(i, i + 200)]);
      return res.status(200).json({ ok: true, hidden });
    }

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
      const subject = clean(o.subject, 200);
      const text = typeof o.text === "string" ? o.text.trim().slice(0, 5000) : "";
      if (!subject) return res.status(400).json({ error: "Subjek email masih kosong" });
      if (!text) return res.status(400).json({ error: "Isi email masih kosong" });
      items.push({ id, to, subject, text });
    }

    // Lewati yang sudah pernah dikirimi
    const skipped = [];
    if (!b.force && dbConfigured() && items.length) {
      const had = await cmd(["HMGET", MAIL, ...items.map(i => i.id)]);
      items = items.filter((i, k) => { if (had[k]) { skipped.push(i.id); return false; } return true; });
    }
    if (!items.length) return res.status(200).json({ sent: [], skipped, bad });

    // Jangan melewati batas harian
    let used = await usedToday();
    if (DAILY > 0 && dbConfigured() && used + items.length > DAILY) {
      const left = Math.max(DAILY - used, 0);
      return res.status(400).json({ error: "Sisa kuota email hari ini " + left + " dari " + DAILY + ". Kurangi jumlah yang dipilih, atau tunggu reset jam 07.00 WIB.", daily: { used, limit: DAILY } });
    }

    const r = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(items.map(i => ({ from, to: [i.to], subject: i.subject, text: i.text, html: buildHtml(i.text), ...(replyTo ? { reply_to: replyTo } : {}) }))),
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
    if (dbConfigured()) {
      try { used = await cmd(["HINCRBY", DAYK, today(), items.length]); } catch (e) { used += items.length; }
    } else used += items.length;
    return res.status(200).json({ sent: items.map(i => i.id), skipped, bad, daily: { used, limit: DAILY } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
