// Endpoint PUBLIK (tanpa login) untuk dua hal, dibedakan lewat ?a=
//   ?a=unsub&e=<email>&t=<tanda tangan>  GET = halaman konfirmasi, POST = berhenti berlangganan (juga untuk "one-click" dari Gmail/Apple Mail)
//   ?a=resend                            POST = webhook Resend (email.bounced, email.complained) -> alamat masuk daftar suppression;
//                                        email.received (balasan masuk) -> dibaca dan diklasifikasi AI (lihat _reply.js)
//   ?a=inbound&k=<INBOUND_SECRET>        POST JSON {from, subject, text, html?, id?} = jalur umum untuk meneruskan balasan dari Gmail (Apps Script), Zapier, Cloudflare Email Worker dll
// Keamanan: tautan berhenti berlangganan bertanda tangan HMAC per alamat (tidak bisa ditebak). Webhook diverifikasi
// tanda tangan Svix memakai RESEND_WEBHOOK_SECRET (isi "whsec_..." dari Resend > Webhooks); tanpa itu webhook ditolak.
const crypto = require("crypto");
const { dbConfigured } = require("./_store");
const M = require("./_mail");
const R = require("./_reply");

const page = (title, body) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<title>" + M.escHtml(title) + '</title><style>body{margin:0;background:#f3efe7;font:16px/1.5 Arial,Helvetica,sans-serif;color:#222}' +
  ".c{max-width:460px;margin:12vh auto;background:#fff;border-radius:10px;padding:28px}h1{font-size:20px;margin:0 0 12px}" +
  "button{font:inherit;background:#000;color:#fff;border:0;border-radius:8px;padding:11px 18px;cursor:pointer}p{margin:0 0 14px}</style></head>" +
  '<body><div class="c">' + body + "</div></body></html>";

function html(res, code, title, body) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(code).send(page(title, body));
}

async function readRaw(req) {
  // Jangan menyentuh req.body dulu: itu memicu parsing dan menghabiskan stream, padahal tanda tangan dihitung dari teks mentah.
  try {
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const s = Buffer.concat(chunks).toString("utf8");
    if (s) return s;
  } catch (e) { /* lanjut ke cadangan */ }
  const b = req.body;
  return typeof b === "string" ? b : (b && typeof b === "object" ? JSON.stringify(b) : "");
}

function svixOk(raw, h, secret) {
  const id = h["svix-id"], ts = h["svix-timestamp"], sigs = h["svix-signature"];
  if (!id || !ts || !sigs || !raw) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
  const exp = crypto.createHmac("sha256", key).update(id + "." + ts + "." + raw).digest("base64");
  return String(sigs).split(" ").some(s => {
    const [v, sig] = s.split(",");
    if (v !== "v1" || !sig) return false;
    const a = Buffer.from(sig), b = Buffer.from(exp);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

module.exports = async (req, res) => {
  try {
    const a = String((req.query && req.query.a) || "");

    if (a === "unsub") {
      const e = String((req.query && req.query.e) || "").trim().toLowerCase();
      const t = String((req.query && req.query.t) || "");
      if (!M.EMAIL.test(e) || !M.tokenOk(e, t)) return html(res, 400, "Invalid link", "<h1>Invalid link</h1><p>This unsubscribe link is not valid.</p>");
      if (req.method === "POST") {
        if (!dbConfigured()) return html(res, 500, "Error", "<h1>Something went wrong</h1><p>Please try again later.</p>");
        await M.suppress(e, "unsub");
        try { await M.flagLeads(e, "unsub"); } catch (x) { /* status gagal diubah tidak boleh menggagalkan berhenti langganan */ }
        return html(res, 200, "Unsubscribed", "<h1>You’re unsubscribed</h1><p>" + M.escHtml(e) + " will not receive any more emails from us.</p>");
      }
      if (req.method === "GET") {
        // GET hanya menampilkan tombol; yang benar-benar berhenti adalah POST, supaya pemindai tautan di email tidak ikut berhenti berlangganan
        return html(res, 200, "Unsubscribe",
          "<h1>Unsubscribe</h1><p>Stop sending emails to <b>" + M.escHtml(e) + "</b>?</p>" +
          '<form method="POST" action="/api/mailhook?a=unsub&e=' + encodeURIComponent(e) + "&t=" + encodeURIComponent(t) + '"><button type="submit">Yes, unsubscribe me</button></form>');
      }
      return res.status(405).json({ error: "metode tidak didukung" });
    }

    if (a === "inbound") { // jalur umum untuk meneruskan balasan dari luar Resend
      if (req.method !== "POST") return res.status(405).json({ error: "metode tidak didukung" });
      const secret = process.env.INBOUND_SECRET || "";
      const k = String((req.query && req.query.k) || (req.headers && req.headers["x-inbound-key"]) || "");
      const ka = Buffer.from(k), kb = Buffer.from(secret);
      if (!secret) return res.status(500).json({ error: "INBOUND_SECRET belum diisi di Vercel" });
      if (ka.length !== kb.length || !crypto.timingSafeEqual(ka, kb)) return res.status(401).json({ error: "kunci tidak valid" });
      let b = req.body;
      if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = null; } }
      if (!b || typeof b !== "object") return res.status(400).json({ error: "isi tidak valid" });
      const out = await R.processReply({ from: b.from, subject: b.subject, text: typeof b.text === "string" ? b.text.slice(0, 20000) : "", html: typeof b.html === "string" ? b.html.slice(0, 40000) : "", mid: b.id ? "in:" + String(b.id).slice(0, 100) : "", src: "inbound", auto: !!b.auto });
      return res.status(out.ok ? 200 : 400).json(out.reply ? { ok: true, cat: out.reply.cat, lead: out.reply.id || "" } : out);
    }

    if (a === "resend") {
      if (req.method !== "POST") return res.status(405).json({ error: "metode tidak didukung" });
      const secret = process.env.RESEND_WEBHOOK_SECRET || "";
      if (!secret) return res.status(500).json({ error: "RESEND_WEBHOOK_SECRET belum diisi di Vercel" });
      const raw = await readRaw(req);
      if (!svixOk(raw, req.headers || {}, secret)) return res.status(401).json({ error: "tanda tangan tidak valid" });
      let ev = null;
      try { ev = JSON.parse(raw); } catch (e) { /* di bawah */ }
      if (!ev || typeof ev !== "object") return res.status(400).json({ error: "isi tidak valid" });
      const type = String(ev.type || ""), d = ev.data || {};
      if (type === "email.received") { // balasan masuk: webhook hanya membawa metadata, isinya diambil lewat API Resend
        const eid = String(d.email_id || d.id || "");
        if (!/^[\w-]{8,80}$/.test(eid)) return res.status(400).json({ error: "email_id tidak valid" });
        const rc = await M.config();
        if (!rc.key) return res.status(500).json({ error: "API key Resend belum diisi" });
        const rr = await fetch("https://api.resend.com/emails/receiving/" + eid, { headers: { Authorization: "Bearer " + rc.key }, signal: AbortSignal.timeout(15000) });
        const full = await rr.json().catch(() => ({}));
        if (!rr.ok) return res.status(502).json({ error: "Gagal mengambil isi email dari Resend (" + rr.status + ")" }); // status 5xx membuat Resend mengulang kirim webhook
        const hd = full.headers || d.headers || {};
        const hv = k => { const key = Object.keys(hd).find(x => x.toLowerCase() === k); return key ? String(hd[key]) : ""; };
        const auto = /auto-(replied|generated)/i.test(hv("auto-submitted")) || /bulk|auto_reply|junk/i.test(hv("precedence")) || !!hv("x-autoreply") || !!hv("x-autorespond");
        const out = await R.processReply({ from: full.from || d.from, subject: full.subject || d.subject, text: full.text, html: full.html, mid: "rs:" + eid, src: "resend", auto });
        return res.status(200).json({ ok: true, reply: !!(out && out.reply), dup: !!(out && out.dup) });
      }
      let reason = "";
      if (type === "email.complained") reason = "spam";
      else if (type === "email.suppressed") reason = "bounce";
      else if (type === "email.bounced") {
        const bt = String((d.bounce && d.bounce.type) || "").toLowerCase();
        if (bt !== "transient") reason = "bounce"; // permanent atau tidak jelas: berhenti kirim. Transient (kotak penuh dll) boleh dicoba lagi nanti
      }
      let n = 0;
      if (reason) {
        const to = Array.isArray(d.to) ? d.to : (d.to ? [d.to] : []);
        for (const addr of to) {
          // Bentuk "Nama <a@b.com>" juga mungkin muncul
          const m = /<([^<>]+)>/.exec(String(addr));
          const a1 = m ? m[1] : addr;
          if (await M.suppress(a1, reason)) { n++; try { await M.flagLeads(a1, reason); } catch (x) { /* abaikan */ } }
        }
      }
      if (n && (reason === "bounce" || reason === "spam")) { try { await M.checkHealth(); } catch (x) { /* abaikan */ } }
      return res.status(200).json({ ok: true, suppressed: n });
    }

    return res.status(404).json({ error: "tidak dikenal" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
