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
  return true;
}

// ---- Tautan berhenti berlangganan ----------------------------------------------------------------
let UK = null;
function unsubKey() {
  if (!UK) UK = crypto.scryptSync(process.env.APP_PASSWORD || "", "hair-leads-unsub-v1", 32);
  return UK;
}
function unsubToken(email) {
  return crypto.createHmac("sha256", unsubKey()).update(String(email).toLowerCase()).digest("hex").slice(0, 32);
}
function tokenOk(email, t) {
  const a = Buffer.from(String(t || "")), b = Buffer.from(unsubToken(email));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
function buildHtml(text, unsub) {
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
  return { key, from, replyTo: EMAIL.test(rt) || /<[^<>@\s]+@[^<>\s]+>$/.test(rt) ? rt : "" };
}

// Kirim satu batch (maksimal MAX) lewat Resend. items: [{to, subject, text}]. Melempar Error berpesan jelas kalau gagal.
async function sendBatch(cfg, items, base) {
  const payload = items.map(i => {
    const u = unsubUrl(base, i.to);
    return {
      from: cfg.from, to: [i.to], subject: i.subject,
      text: i.text + (u ? "\n\n--\nTo stop receiving emails from us, click here: " + u : ""),
      html: buildHtml(i.text, u),
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
      try { await cmd(["HSET", MAIL, i.id, JSON.stringify({ t, to: i.to })]); } catch (e) { /* gagal catat tidak boleh menggagalkan hasil */ }
    }
    try { return await cmd(["HINCRBY", DAYK, today(), items.length]); } catch (e) { return used + items.length; }
  }
  return used + items.length;
}

module.exports = { MAIL, DAYK, SUPP, MAX, DAILY, EMAIL, ID, clean, parse, escHtml, usedToday, suppressedSet, suppress,
  unsubToken, tokenOk, baseUrl, unsubUrl, buildHtml, greet, config, sendBatch, recordSent };
