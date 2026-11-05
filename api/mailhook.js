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

const ICONS = {
  mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"/><path d="m3.5 7.5 8.5 6 8.5-6"/></svg>',
  ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16 9.8"/></svg>',
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/></svg>'
};

// kind: mail (konfirmasi) | ok (berhasil) | warn (galat). extra = HTML tambahan di bawah teks (mis. tombol).
const card = (kind, heading, text, extra) =>
  '<div class="ic ' + kind + '">' + ICONS[kind] + "</div><h1>" + heading + "</h1><p>" + text + "</p>" + (extra || "");

const page = (title, body) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<link rel="icon" href="https://emahairshop.com/favicon.svg"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark">' +
  "<title>" + M.escHtml(title) + "</title><style>" +
  ":root{--bg:#f3efe7;--card:#fff;--text:#1d1d1f;--muted:#6b6b6b;--line:#ebe6db;--btn:#111;--btn-text:#fff;--ok:#1f8a4c;--ok-bg:#e6f4ec;--warn:#b3261e;--warn-bg:#fbeae8;--mail-bg:#f1ede4;--mail:#555}" +
  "@media (prefers-color-scheme:dark){:root{--bg:#141414;--card:#1e1e1e;--text:#f2f2f2;--muted:#a3a3a3;--line:#2c2c2c;--btn:#f2f2f2;--btn-text:#111;--ok:#5cd18a;--ok-bg:#16301f;--warn:#ff8a80;--warn-bg:#3a1b19;--mail-bg:#2a2a2a;--mail:#bdbdbd}}" +
  "*{box-sizing:border-box}html,body{height:100%}" +
  "body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px 24px calc(24px + 16vh);-webkit-font-smoothing:antialiased}" +
  ".wrap{width:100%;max-width:440px}" +
  ".brand{display:flex;justify-content:center;margin:0 0 22px}.logo{display:inline-block;text-align:center;color:var(--text);line-height:1}" +
  ".logo .top{display:flex;align-items:center;gap:8px;margin-bottom:5px}.logo .top i{flex:1;height:2px;background:currentColor}" +
  ".logo .top span{font-size:8px;font-weight:700;letter-spacing:.32em;margin-right:-.32em}" +
  ".logo .name{display:block;font-size:27px;font-weight:800;letter-spacing:.005em;padding-bottom:4px;border-bottom:3px solid currentColor}" +
  ".logo .yr{display:block;margin-top:6px;font-size:9px;font-weight:700;letter-spacing:.3em;margin-right:-.3em;color:#b8996a}" +
  ".c{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:36px 32px 32px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px rgba(0,0,0,.06)}" +
  ".ic{width:56px;height:56px;border-radius:50%;margin:0 auto 20px;display:flex;align-items:center;justify-content:center}" +
  ".ic svg{width:28px;height:28px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}" +
  ".ic.mail{background:var(--mail-bg);color:var(--mail)}.ic.ok{background:var(--ok-bg);color:var(--ok)}.ic.warn{background:var(--warn-bg);color:var(--warn)}" +
  "h1{font-size:22px;line-height:1.3;margin:0 0 10px;font-weight:700;letter-spacing:-.01em}" +
  "p{margin:0;color:var(--muted);overflow-wrap:anywhere}p b{color:var(--text);font-weight:600}" +
  "form{margin:26px 0 0}" +
  "button{width:100%;font:inherit;font-weight:600;background:var(--btn);color:var(--btn-text);border:0;border-radius:10px;padding:13px 18px;cursor:pointer;transition:opacity .15s,transform .05s}" +
  "button:hover{opacity:.88}button:active{transform:scale(.99)}button:focus-visible{outline:2px solid var(--text);outline-offset:3px}" +
  ".note{margin:18px 0 0;font-size:13px;color:var(--muted)}" +
  "@media (max-width:480px){body{padding:16px 16px calc(16px + 10vh)}.c{padding:28px 22px 24px}}" +
  '</style></head><body><div class="wrap"><div class="brand"><div class="logo" role="img" aria-label="EMAHAIRSHOP Extension 2019"><div class="top"><i></i><span>EXTENSION</span></div><span class="name">EMAHAIRSHOP</span><span class="yr">2019</span></div></div><div class="c">' + body + "</div></div></body></html>";

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
      if (!M.EMAIL.test(e) || !M.tokenOk(e, t)) return html(res, 400, "Invalid link", card("warn", "Invalid link", "This unsubscribe link is not valid or has expired."));
      if (req.method === "POST") {
        if (!dbConfigured()) return html(res, 500, "Error", card("warn", "Something went wrong", "Please try again in a few minutes."));
        await M.suppress(e, "unsub");
        try { await M.flagLeads(e, "unsub"); } catch (x) { /* status gagal diubah tidak boleh menggagalkan berhenti langganan */ }
        return html(res, 200, "Unsubscribed", card("ok", "You’re unsubscribed", "<b>" + M.escHtml(e) + "</b> will not receive any more emails from us."));
      }
      if (req.method === "GET") {
        // GET hanya menampilkan tombol; yang benar-benar berhenti adalah POST, supaya pemindai tautan di email tidak ikut berhenti berlangganan
        return html(res, 200, "Unsubscribe", card("mail", "Unsubscribe", "Stop sending emails to <b>" + M.escHtml(e) + "</b>?",
          '<form method="POST" action="/api/mailhook?a=unsub&e=' + encodeURIComponent(e) + "&t=" + encodeURIComponent(t) + '"><button type="submit">Yes, unsubscribe me</button></form>' +
          '<p class="note">You can simply close this page if you changed your mind.</p>'));
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
