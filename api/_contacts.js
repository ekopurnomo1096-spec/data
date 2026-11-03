// Cari email dan WhatsApp dari website sebuah bisnis (gratis, tanpa API key). Dipakai api/email.js dan pekerjaan otomatis (_jobs.js).
const BAD = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?)$|sentry|wixpress|example\.|domain\.com|your(name|email)|@2x|noreply|no-reply/i;
const WA = /(?:wa\.me\/|(?:api|web)\.whatsapp\.com\/send\/?\?(?:[^"'\s>]*?&(?:amp;)?)?phone=)\+?(\d{8,15})/gi;
const PATHS = ["/contact", "/contact-us", "/pages/contact", "/pages/contact-us", "/kontak", "/contacts", "/about", "/about-us"];
const MAXPAGES = 6; // paling banyak halaman yang dicek per website

function blocked(host) {
  return /^(localhost|.*\.local|.*\.internal)$/i.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
}

// Mengembalikan {html, err}. err = true kalau situs gagal dijangkau (timeout, jaringan, 5xx, 429). 404 dan sejenisnya bukan kegagalan.
async function grab(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 6000);
  try {
    const r = await fetch(url, { signal: c.signal, redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; hair-leads-demo/1.0)", "Accept": "text/html" } });
    if (!r.ok) return { html: "", err: r.status >= 500 || r.status === 429 };
    return { html: (await r.text()).slice(0, 600000), err: false };
  } catch (e) { return { html: "", err: true }; } finally { clearTimeout(t); }
}

// Cari tautan "contact/kontak" di halaman utama (satu host yang sama), maksimal 2
function contactLinks(html, base) {
  const out = [];
  for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    if (!/contact|kontak|hubungi/i.test(m[1])) continue;
    try {
      const u = new URL(m[1].replace(/&amp;/g, "&"), base);
      if (u.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) continue;
      if (/\.(png|jpe?g|gif|svg|webp|pdf|css|js)$/i.test(u.pathname)) continue;
      const h = u.origin + u.pathname;
      if (!out.includes(h) && h !== base.origin + base.pathname) out.push(h);
    } catch (e) { /* tautan rusak diabaikan */ }
    if (out.length >= 2) break;
  }
  return out;
}

// Mengembalikan {emails, whatsapp, failed}. failed = halaman utama gagal dijangkau (boleh dicoba ulang). Melempar Error dengan properti status (400) kalau alamatnya tidak valid / tidak diizinkan.
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
  let queue = [base.href], seen = new Set(), failed = false, n = 0;
  while (queue.length && n < MAXPAGES) {
    if (deadline && Date.now() > deadline) break;
    const href = queue.shift();
    if (seen.has(href)) continue;
    seen.add(href);
    const g = await grab(href);
    n++;
    if (n === 1) {
      if (g.err) { failed = true; break; } // halaman utama tidak terjangkau: jangan buang waktu di halaman lain
      queue = [...contactLinks(g.html, base), ...PATHS.map(p => new URL(p, base).href)];
    }
    const text = g.html.replace(/&#0*64;|&commat;|\[at\]/gi, "@");
    (text.match(/mailto:([^"'?>\s]+)/gi) || []).forEach(m => found.add(m.slice(7).toLowerCase()));
    (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).forEach(m => found.add(m.toLowerCase()));
    for (const m of text.matchAll(WA)) wa.add(m[1]);
    if ([...found].some(e => !BAD.test(e)) && wa.size) break;
  }
  const score = e => (e.endsWith("@" + root) || e.endsWith("." + root) ? 0 : 2) + (/^(info|contact|hello|sales|enquiries|admin|cs)@/.test(e) ? 0 : 1);
  const emails = [...found].filter(e => !BAD.test(e)).sort((a, b) => score(a) - score(b)).slice(0, 3);
  return { emails, whatsapp: [...wa].slice(0, 2), failed };
}

module.exports = { findContacts };
