// Pembantu email bersama: dipakai send.js (kirim manual), _jobs.js (kirim otomatis), dan mailhook.js (berhenti berlangganan + webhook).
// Isinya: pembungkus HTML, pengaturan Resend, batas harian, daftar suppression (alamat yang tidak boleh dikirimi lagi),
// tautan berhenti berlangganan bertanda tangan, dan pengirim batch ke Resend.
const crypto = require("crypto");
const { dbConfigured, getKey, cmd } = require("./_store");
const { BRAND } = require("./_template");

const MAIL = "hairleads:mail";
const DAYK = "hairleads:mailday"; // hitungan email terkirim per hari (UTC), field = "YYYY-MM-DD"
const SUPP = "hairleads:supp";    // alamat yang tidak boleh dikirimi: {alamat: {r:"unsub|bounce|spam|manual", t}}
const MAX = 20;
// Batas harian. Akun gratis Resend 100 email per hari (reset tengah malam UTC = 07.00 WIB).
// Ganti lewat RESEND_DAILY_LIMIT di Vercel. Isi 0 kalau akun berbayar tanpa batas harian.
const DAILY = (() => { const v = process.env.RESEND_DAILY_LIMIT; if (v === undefined || v === "") return 100; const n = parseInt(v, 10); return n >= 0 ? n : 100; })();
const today = () => new Date().toISOString().slice(0, 10);
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[A-Za-z]{2,}$/;
const ID = /^[\w:./|-]{1,120}$/;
const clean = (v, n) => String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").replace(/[<>]/g, "").trim().slice(0, n);
const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };

async function usedToday() {
  if (!dbConfigured()) return 0;
  try { return parseInt(await cmd(["HGET", DAYK, today()]), 10) || 0; } catch (e) { return 0; }
}

// ---- Suppression -----------------------------------------------------------------------------
async function suppressedSet(emails) {
  const out = new Set();
  if (!dbConfigured() || !emails.length) return out;
  const list = [...new Set(emails.map(e => String(e || "").toLowerCase()).filter(Boolean))];
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const got = await cmd(["HMGET", SUPP, ...chunk]);
    chunk.forEach((e, k) => { if (got[k]) out.add(e); });
  }
  return out;
}
async function suppress(email, reason) {
  email = String(email || "").trim().toLowerCase();
  if (!EMAIL.test(email) || !dbConfigured()) return false;
  const had = await cmd(["HEXISTS", SUPP, email]);
  if (had) return true; // alasan pertama dipertahankan
  await cmd(["HSET", SUPP, email, JSON.stringify({ r: reason || "manual", t: Date.now() })]);
  if (reason === "bounce" || reason === "spam" || reason === "unsub") await stat(reason, 1);
  return true;
}

// ---- Tautan berhenti berlangganan ----------------------------------------------------------------
// Kunci tanda tangan: UNSUB_SECRET (disarankan, terpisah dari kata sandi) dipakai untuk tautan baru.
// Kunci dari APP_PASSWORD tetap diterima supaya tautan di email lama tidak mati.
let UKS = null;
function unsubKeys() {
  if (!UKS) {
    const mk = s => crypto.scryptSync(s, "hair-leads-unsub-v1", 32);
    UKS = [];
    if (process.env.UNSUB_SECRET) UKS.push(mk(process.env.UNSUB_SECRET));
    UKS.push(mk(process.env.APP_PASSWORD || ""));
  }
  return UKS;
}
const sign = (k, email) => crypto.createHmac("sha256", k).update(String(email).toLowerCase()).digest("hex").slice(0, 32);
function unsubToken(email) { return sign(unsubKeys()[0], email); }
function tokenOk(email, t) {
  const a = Buffer.from(String(t || ""));
  return unsubKeys().some(k => { const b = Buffer.from(sign(k, email)); return a.length === b.length && crypto.timingSafeEqual(a, b); });
}
// Alamat situs ini sendiri (untuk tautan di dalam email). Dari permintaan kalau ada, kalau tidak dari env Vercel.
// PUBLIC_URL (kalau diisi di Vercel) diutamakan, supaya tautan selalu memakai domain sendiri, termasuk saat dipanggil cron.
function baseUrl(req) {
  const norm = e => (/^https?:\/\//i.test(e) ? e : "https://" + e).replace(/\/+$/, "");
  if (process.env.PUBLIC_URL) return norm(process.env.PUBLIC_URL);
  const h = req && req.headers && (req.headers["x-forwarded-host"] || req.headers.host);
  if (h) return "https://" + String(h).split(",")[0].trim();
  const e = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "";
  return e ? norm(e) : "";
}
const unsubUrl = (base, email) => base ? base + "/api/mailhook?a=unsub&e=" + encodeURIComponent(email) + "&t=" + unsubToken(email) : "";

// ---- Isi email ---------------------------------------------------------------------------------
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
// Keterangan sumber kontak bawaan (bisa diganti di tab Email > Pengaturan email)
const DEFAULT_SRC = "We found your email address on your business website or public listing.";
function buildHtml(text, unsub, foot) {
  foot = foot || {};
  const siteLabel = escHtml(BRAND.website.replace(/^https?:\/\//, "").replace(/\/$/, ""));
  return '<!doctype html><html><body style="margin:0;padding:0;background:#f3efe7;font-family:Arial,Helvetica,sans-serif">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3efe7;padding:24px 0"><tr><td align="center">' +
    '<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden" cellpadding="0" cellspacing="0"><tr><td>' +
    '<div style="background:#000000;padding:22px 28px">' +
    '<span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.02em">' + escHtml(BRAND.name) + "</span></div>" +
    '<div style="padding:28px;color:#2a2a2a;font-size:15px;line-height:1.55">' + textToHtmlBody(text) + "</div>" +
    '<div style="padding:18px 28px;background:#f6f3ec;border-top:1px solid #e7e1d4;font-size:12.5px;color:#4a4a4a">' +
    "<div style=\"margin-bottom:6px\"><b>" + escHtml(BRAND.name) + "</b> — " + escHtml(BRAND.tagline) + "</div>" +
    "<div>Website: <a href=\"" + escHtml(BRAND.website) + "\" style=\"color:#000000;text-decoration:underline\">" + siteLabel + "</a></div>" +
    (foot.addr ? "<div style=\"margin-top:8px\">" + escHtml(foot.addr) + "</div>" : "") +
    (foot.srcn ? "<div style=\"margin-top:8px;color:#6a6a6a\">" + escHtml(foot.srcn) + "</div>" : "") +
    (unsub ? "<div style=\"margin-top:10px;color:#6a6a6a\">Don’t want to hear from us? <a href=\"" + escHtml(unsub) + "\" style=\"color:#6a6a6a;text-decoration:underline\">Unsubscribe</a></div>" : "") +
    "</div></td></tr></table></td></tr></table></body></html>";
}

// Sapaan "Hi!" di baris pertama diganti nama tempat, sama seperti di halaman (index.html)
function greet(text, name) {
  const n = clean(name, 80);
  return String(text || "").replace(/^\s*Hi!/, n ? "Hi " + n + " team!" : "Hi!");
}

// ---- Resend ------------------------------------------------------------------------------------
async function config() {
  const key = (await getKey("rs")) || process.env.RESEND_API_KEY || "";
  const from = (await getKey("rsf")) || process.env.RESEND_FROM || "";
  const rt = ((await getKey("rrt")) || process.env.RESEND_REPLY_TO || "").trim();
  const addr = ((await getKey("addr")) || "").trim().slice(0, 300);
  const srcn = ((await getKey("srcn")) || "").trim().slice(0, 300) || DEFAULT_SRC;
  return { key, from, addr, srcn, replyTo: EMAIL.test(rt) || /<[^<>@\s]+@[^<>\s]+>$/.test(rt) ? rt : "" };
}

// Kirim satu batch (maksimal MAX) lewat Resend. items: [{to, subject, text}]. Melempar Error berpesan jelas kalau gagal.
async function sendBatch(cfg, items, base) {
  const payload = items.map(i => {
    const u = unsubUrl(base, i.to);
    return {
      from: cfg.from, to: [i.to], subject: i.subject,
      text: i.text + "\n\n--\n" + BRAND.name + (cfg.addr ? "\n" + cfg.addr : "") + (cfg.srcn ? "\n" + cfg.srcn : "") + (u ? "\nTo stop receiving emails from us, click here: " + u : ""),
      html: buildHtml(i.text, u, { addr: cfg.addr, srcn: cfg.srcn }),
      ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
      ...(u ? { headers: { "List-Unsubscribe": "<" + u + ">", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {})
    };
  });
  const r = await fetch("https://api.resend.com/emails/batch", {
    method: "POST",
    headers: { Authorization: "Bearer " + cfg.key, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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
}

// Catat riwayat kirim (hairleads:mail) dan tambah hitungan harian. Mengembalikan jumlah terpakai hari ini.
// Item dengan fu:true (follow-up) hanya dihitung ke kuota harian; catatan "pertama kali dikirimi" tidak ditimpa.
async function recordSent(items, used) {
  const t = Date.now();
  if (dbConfigured()) {
    for (const i of items) {
      if (i.fu) continue;
      const rec = { t, to: i.to };
      if (i.v !== undefined) { rec.s = i.n || 0; rec.v = i.v; } // tahap dan variasi yang terkirim (untuk A/B)
      try { await cmd(["HSET", MAIL, i.id, JSON.stringify(rec)]); } catch (e) { /* gagal catat tidak boleh menggagalkan hasil */ }
    }
    try {
      const fu = items.filter(i => i.fu).length;
      await stat("sent", items.length - fu); await stat("fu", fu);
      const per = {};
      for (const i of items) if (i.v !== undefined) { const k = "s" + (i.n || 0) + "v" + i.v; per[k] = (per[k] || 0) + 1; }
      for (const k of Object.keys(per)) await stat(k, per[k]);
      await cmd(["HSETNX", AUTOK, "first", String(t)]); // tanggal kirim pertama, dasar pemanasan (warm-up)
    } catch (e) { /* statistik gagal tidak boleh menggagalkan hasil */ }
    try { return await cmd(["HINCRBY", DAYK, today(), items.length]); } catch (e) { return used + items.length; }
  }
  return used + items.length;
}

// ---- Statistik harian, jeda (kill switch), dan batas bounce ----------------------------------------------
const STATK = "hairleads:stats"; // field "YYYY-MM-DD:metrik" (UTC). Metrik: sent, fu, bounce, spam, unsub, added, found, queued, reply, s{tahap}v{variasi}
const AUTOK = "hairleads:auto";  // sama dengan AUTO di _jobs.js (field cfg, log, first, pause, pbase)
async function stat(metric, n) {
  if (!dbConfigured() || !n) return;
  try { await cmd(["HINCRBY", STATK, today() + ":" + metric, Math.round(n)]); } catch (e) { /* abaikan */ }
}
// Mengembalikan [{d:"YYYY-MM-DD", sent, fu, bounce, spam, unsub, added, found, queued, v:{s0v0:n,...}}], terbaru dulu
async function getStats(days) {
  if (!dbConfigured()) return [];
  const raw = (await cmd(["HGETALL", STATK])) || [], by = {};
  const from = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [d, m] = String(raw[i]).split(":");
    if (!m || d < from) continue;
    const o = by[d] || (by[d] = { d, sent: 0, fu: 0, bounce: 0, spam: 0, unsub: 0, added: 0, found: 0, queued: 0, reply: 0, v: {} });
    const n = parseInt(raw[i + 1], 10) || 0;
    if (/^s\d+v\d+$/.test(m)) o.v[m] = n; else if (m in o) o[m] = n;
  }
  const out = [];
  for (let k = 0; k < days; k++) { const d = new Date(Date.now() - k * 864e5).toISOString().slice(0, 10); out.push(by[d] || { d, sent: 0, fu: 0, bounce: 0, spam: 0, unsub: 0, added: 0, found: 0, queued: 0, reply: 0, v: {} }); }
  return out;
}
async function getPause() {
  if (!dbConfigured()) return null;
  try { const v = parse(await cmd(["HGET", AUTOK, "pause"])); return v && v.t ? v : null; } catch (e) { return null; }
}
async function setPause(why, auto) {
  await cmd(["HSET", AUTOK, "pause", JSON.stringify({ t: Date.now(), why: clean(why, 200) || "dijeda", auto: !!auto })]);
  if (auto) { // jeda karena bounce/spam: selalu diberi tahu lewat email (kalau Resend dan penerima laporan sudah ada)
    try {
      await alertNotice("pause", "Kirim email dijeda otomatis",
        "Semua kirim email dan pekerjaan otomatis dihentikan.\n\nAlasan: " + clean(why, 200) +
        "\n\nYang perlu dilakukan:\n- Cek email yang bounce atau dilaporkan spam di dashboard Resend.\n- Periksa sumber alamat email yang dipakai.\n- Setelah aman, buka tab Otomatis lalu klik Lanjutkan.", true);
    } catch (e) { /* peringatan gagal terkirim tidak boleh menggagalkan jeda */ }
  }
}

// ---- Laporan dan peringatan lewat email ----------------------------------------------------------------------
// Penerima: pengaturan notify.to di tab Otomatis, kalau kosong memakai alamat Reply-To. Dikirim lewat Resend yang sama,
// langsung (bukan lewat batch kirim prospek), jadi tidak ikut meter "email hari ini" dan tidak diberi tautan berhenti.
async function notifyTarget() {
  let n = {};
  try { const c = parse(await cmd(["HGET", AUTOK, "cfg"])); n = (c && c.notify) || {}; } catch (e) { /* bawaan */ }
  let to = String(n.to || "").trim();
  if (!EMAIL.test(to)) {
    let rt = "";
    try { rt = (await config()).replyTo || ""; } catch (e) { /* tanpa Reply-To */ }
    const m = /<([^<>]+)>/.exec(rt), r = (m ? m[1] : rt).trim();
    to = EMAIL.test(r) ? r : "";
  }
  return { to, alerts: n.alerts !== false, digest: n.digest !== false };
}
async function sendNotice(to, subject, text) {
  const rc = await config();
  if (!rc.key || !/@/.test(rc.from)) throw new Error("Resend belum diisi (API key dan email pengirim)");
  const html = '<div style="font-family:Consolas,Menlo,monospace;font-size:13px;line-height:1.55;color:#222;white-space:pre-wrap">' + escHtml(text) + "</div>";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + rc.key, "Content-Type": "application/json" },
    body: JSON.stringify({ from: rc.from, to: [to], subject: clean(subject, 200), text, html }),
    signal: AbortSignal.timeout(12000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Resend: " + String(j.message || j.error || r.status));
}
// Peringatan: sekali sehari per jenis (kind), kecuali every=true. Mengembalikan true kalau terkirim.
async function alertNotice(kind, subject, text, every) {
  if (!dbConfigured()) return false;
  const n = await notifyTarget();
  if (!n.alerts || !n.to) return false;
  const field = "al:" + kind;
  if (!every) { try { if ((await cmd(["HGET", AUTOK, field])) === today()) return false; } catch (e) { /* kirim saja */ } }
  await sendNotice(n.to, "[Peringatan] " + subject, text);
  try { await cmd(["HSET", AUTOK, field, today()]); } catch (e) { /* abaikan */ }
  return true;
}
// Lanjutkan. Hitungan bounce/spam yang ada saat ini dijadikan titik nol supaya tidak langsung terjeda lagi.
async function clearPause() {
  const w = windowTotals(await getStats(3));
  await cmd(["HSET", AUTOK, "pbase", JSON.stringify({ t: Date.now(), sent: w.sent, bounce: w.bounce, spam: w.spam })]);
  await cmd(["HDEL", AUTOK, "pause"]);
}
const windowTotals = st => st.reduce((a, x) => ({ sent: a.sent + x.sent + x.fu, bounce: a.bounce + x.bounce, spam: a.spam + x.spam }), { sent: 0, bounce: 0, spam: 0 });
// Cek 3 hari terakhir: bounce >= batas % (minimal 20 email terkirim), atau spam >= 2 dan >= 0,3%. Kalau terlewati, kirim otomatis dijeda.
// Mengembalikan alasan (string) kalau baru saja dijeda atau sudah dijeda, "" kalau aman.
async function checkHealth() {
  if (!dbConfigured()) return "";
  const pz = await getPause();
  if (pz) return pz.why || "dijeda";
  let max = 4;
  try { const c = parse(await cmd(["HGET", AUTOK, "cfg"])); const v = c && c.mail && Number(c.mail.maxBounce); if (v >= 1 && v <= 20) max = v; } catch (e) { /* bawaan */ }
  let w = windowTotals(await getStats(3));
  try {
    const b = parse(await cmd(["HGET", AUTOK, "pbase"]));
    if (b && Date.now() - b.t < 3 * 864e5) w = { sent: Math.max(w.sent - b.sent, 0), bounce: Math.max(w.bounce - b.bounce, 0), spam: Math.max(w.spam - b.spam, 0) };
  } catch (e) { /* tanpa titik nol */ }
  if (w.sent < 20) return "";
  const br = w.bounce / w.sent * 100, sr = w.spam / w.sent * 100;
  let why = "";
  if (br >= max) why = "Bounce " + br.toFixed(1) + "% (" + w.bounce + " dari " + w.sent + " email dalam 3 hari) melewati batas " + max + "%";
  else if (w.spam >= 2 && sr >= 0.3) why = "Laporan spam " + w.spam + " dari " + w.sent + " email dalam 3 hari (" + sr.toFixed(2) + "%)";
  if (why) { await setPause(why, true); return why; }
  return "";
}

// ---- Verifikasi MX (gratis, tanpa API) -------------------------------------------------------------
const MXK = "hairleads:mx"; // {domain: {ok:true|false, t}}; hasil disimpan 14 hari (gagal 3 hari)
const dns = require("dns").promises;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), ms))]);
// true = domain bisa menerima email, false = pasti tidak bisa, null = tidak bisa dipastikan sekarang (jangan dianggap salah)
async function mxLookup(domain) {
  try {
    const mx = await withTimeout(dns.resolveMx(domain), 4000);
    if (mx && mx.some(m => m.exchange && m.exchange !== ".")) return true;
    if (mx && mx.length) return false; // "null MX" (RFC 7505): domain menolak email
  } catch (e) {
    if (e.code !== "ENODATA" && e.code !== "ENOTFOUND") return null;
  }
  try { // tanpa MX, alamat A dianggap tujuan email (aturan SMTP)
    const a = await withTimeout(dns.resolve4(domain), 4000);
    return !!(a && a.length);
  } catch (e) { return e.code === "ENODATA" || e.code === "ENOTFOUND" ? false : null; }
}
// domains: array nama domain. Mengembalikan Map domain -> true|false. Domain yang belum sempat/ tidak bisa dipastikan tidak ada di Map.
async function mxCheck(domains, deadline) {
  const out = new Map(), list = [...new Set(domains.map(d => String(d || "").toLowerCase()).filter(Boolean))];
  if (!list.length) return out;
  const now = Date.now(), cache = {};
  if (dbConfigured()) {
    try {
      for (let i = 0; i < list.length; i += 200) {
        const chunk = list.slice(i, i + 200), got = await cmd(["HMGET", MXK, ...chunk]);
        chunk.forEach((d, k) => { const v = got[k] && parse(got[k]); if (v) cache[d] = v; });
      }
    } catch (e) { /* tanpa cache tetap jalan */ }
  }
  const todo = [];
  for (const d of list) {
    const c = cache[d];
    if (c && now - c.t < (c.ok ? 14 : 3) * 864e5) out.set(d, !!c.ok); else todo.push(d);
  }
  const save = [];
  for (let i = 0; i < todo.length; i += 10) {
    if (deadline && Date.now() > deadline) break;
    const chunk = todo.slice(i, i + 10);
    const res = await Promise.all(chunk.map(d => mxLookup(d).catch(() => null)));
    chunk.forEach((d, k) => { if (res[k] !== null) { out.set(d, res[k]); save.push(d, JSON.stringify({ ok: res[k], t: now })); } });
  }
  if (save.length && dbConfigured()) { try { for (let i = 0; i < save.length; i += 200) await cmd(["HSET", MXK, ...save.slice(i, i + 200)]); } catch (e) { /* abaikan */ } }
  return out;
}
const domainOf = e => String(e || "").toLowerCase().split("@")[1] || "";

// ---- Status prospek saat alamat masuk suppression ---------------------------------------------------
// Prospek yang pernah dikirimi email ke alamat itu: status "Dibalas/Deal/Tidak" tidak diubah; "" atau "Sudah dihubungi" jadi "Tidak cocok" + catatan.
const BLN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
async function flagLeads(email, reason) {
  email = String(email || "").trim().toLowerCase();
  if (!dbConfigured() || !email) return 0;
  const LEADS = "hairleads:leads", d = new Date(Date.now() + 7 * 36e5);
  const label = { bounce: "Email bounce", spam: "Lapor spam", unsub: "Berhenti langganan" }[reason] || "Masuk daftar berhenti";
  const line = label + ", " + d.getUTCDate() + " " + BLN[d.getUTCMonth()];
  const all = await cmd(["HGETALL", MAIL]), ids = [];
  const arr = Array.isArray(all) ? all : [];
  for (let i = 0; i + 1 < arr.length; i += 2) { const v = parse(arr[i + 1]); if (v && String(v.to || "").toLowerCase() === email) ids.push(arr[i]); }
  let n = 0;
  for (const id of ids) {
    const rec = parse(await cmd(["HGET", LEADS, id]));
    if (!rec || (rec.s && rec.s !== "chat")) continue;
    rec.s = "tidak";
    const nt = String(rec.n || "");
    if (nt.indexOf(line) < 0) rec.n = nt ? nt + "\n" + line : line;
    rec.t = Date.now();
    await cmd(["HSET", LEADS, id, JSON.stringify(rec)]);
    n++;
  }
  return n;
}

module.exports = { stat, getStats, getPause, setPause, clearPause, checkHealth, mxCheck, domainOf, flagLeads, MAIL, DAYK, SUPP, MAX, DAILY, EMAIL, ID, clean, parse, escHtml, usedToday, suppressedSet, suppress,
  unsubToken, tokenOk, baseUrl, unsubUrl, buildHtml, greet, config, sendBatch, recordSent, notifyTarget, sendNotice, alertNotice, today };
