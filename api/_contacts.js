// Cari email dan WhatsApp dari website sebuah bisnis (gratis, tanpa API key). Dipakai api/email.js dan pekerjaan otomatis (_jobs.js).
const BAD = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?)$|sentry|wixpress|example\.|domain\.com|your(name|email)|@2x|noreply|no-reply/i;
const WA = /(?:wa\.me\/|(?:api|web)\.whatsapp\.com\/send\/?\?(?:[^"'\s>]*?&(?:amp;)?)?phone=)\+?(\d{8,15})/gi;
const PATHS = ["", "/contact", "/contact-us", "/kontak", "/about"];

function blocked(host) {
  return /^(localhost|.*\.local|.*\.internal)$/i.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
}

async function grab(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 6000);
  try {
    const r = await fetch(url, { signal: c.signal, redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; hair-leads-demo/1.0)", "Accept": "text/html" } });
    if (!r.ok) return "";
    return (await r.text()).slice(0, 600000);
  } catch (e) { return ""; } finally { clearTimeout(t); }
}

// Mengembalikan {emails, whatsapp}. Melempar Error dengan properti status (400) kalau alamatnya tidak valid / tidak diizinkan.
// deadline (ms epoch, opsional): berhenti memeriksa halaman lain kalau sudah lewat, supaya fungsi tidak melewati batas waktu.
async function findContacts(url, deadline) {
  let u = String(url || "").trim();
  const fail = m => { const e = new Error(m); e.status = 400; return e; };
  if (!u) throw fail("url kosong");
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  let base;
  try { base = new URL(u); } catch (e) { throw fail("url tidak valid"); }
  if (blocked(base.hostname)) throw fail("alamat tidak diizinkan");

  const root = base.hostname.replace(/^www\./, "");
  const found = new Set();
  const wa = new Set();
  for (const p of PATHS) {
    if (deadline && Date.now() > deadline) break;
    const html = await grab(p ? new URL(p, base).href : base.href);
    const text = html.replace(/&#0*64;|&commat;|\[at\]/gi, "@");
    (text.match(/mailto:([^"'?>\s]+)/gi) || []).forEach(m => found.add(m.slice(7).toLowerCase()));
    (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).forEach(m => found.add(m.toLowerCase()));
    for (const m of text.matchAll(WA)) wa.add(m[1]);
    if ([...found].some(e => !BAD.test(e)) && wa.size) break;
  }
  const score = e => (e.endsWith("@" + root) || e.endsWith("." + root) ? 0 : 2) + (/^(info|contact|hello|sales|enquiries|admin|cs)@/.test(e) ? 0 : 1);
  const emails = [...found].filter(e => !BAD.test(e)).sort((a, b) => score(a) - score(b)).slice(0, 3);
  return { emails, whatsapp: [...wa].slice(0, 2) };
}

module.exports = { findContacts };
