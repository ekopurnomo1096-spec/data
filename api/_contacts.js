// Cari email dan WhatsApp dari website sebuah bisnis (gratis, tanpa API key). Dipakai api/email.js dan pekerjaan otomatis (_jobs.js).
const dns = require("dns").promises;
const { isIP } = require("net");
const BAD = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?)$|sentry|wixpress|example\.|domain\.com|your(name|email)|@2x|noreply|no-reply|^(you|your|yours|name|yourname|youremail|email|user|username|test|tester|someone|johndoe|janedoe|nama|emailanda|anda)@|@(yoursite|yourdomain|mysite|mydomain|site|website|company|email|test)\.[a-z]+$/i;
const WA = /(?:wa\.me\/|(?:api|web)\.whatsapp\.com\/send\/?\?(?:[^"'\s>]*?&(?:amp;)?)?phone=)\+?(\d{8,15})/gi;
const PATHS = ["/contact", "/contact-us", "/pages/contact", "/pages/contact-us", "/kontak", "/contacts", "/about", "/about-us"];
const MAXPAGES = 6; // paling banyak halaman yang dicek per website
const MAXHOPS = 6;  // paling banyak loncatan redirect yang diikuti per halaman

function blocked(host) {
  return /^(localhost|.*\.local|.*\.internal)$/i.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
}
// true kalau alamat IP ini privat/loopback/link-local/tidak boleh dijangkau dari luar (cegah SSRF ke jaringan internal).
function ipBlocked(ip) {
  const fam = isIP(ip);
  if (fam === 4) {
    const p = ip.split(".").map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0 || p[0] >= 224) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    return false;
  }
  if (fam === 6) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true; // link-local & unique local
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low); // IPv4 yang dibungkus IPv6
    if (m) return ipBlocked(m[1]);
    return false;
  }
  return true; // bukan IP yang dikenali: lebih aman dianggap diblokir
}
// Cek nama host sebelum DIHUBUNGI (bukan cuma sebelum dipakai di URL): resolve DNS-nya dan pastikan semua alamat
// hasil resolve itu bukan IP privat. Mencegah situs yang domainnya sengaja/kebetulan diarahkan ke jaringan internal
// (DNS rebinding) ikut lolos cuma karena nama hostnya terlihat normal.
async function hostBlocked(host) {
  if (blocked(host)) return true;
  try {
    const addrs = await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000))
    ]);
    return !addrs.length || addrs.some(a => ipBlocked(a.address));
  } catch (e) { return true; } // gagal resolve: lebih aman dianggap diblokir daripada diizinkan
}

// Bersihkan alamat hasil tangkap dari halaman web: sisa penulisan URL (mis. "%20" di depan), spasi, dan tanda baca di ujung dibuang.
function tidyEmail(e) {
  let t = String(e || "");
  try { t = decodeURIComponent(t); } catch (x) { /* ada "%" yang bukan kode URL: biarkan apa adanya */ }
  return (t.trim().split(/\s+/).pop() || "").toLowerCase().replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "");
}

// Mengembalikan {html, err}. err = true kalau situs gagal dijangkau (timeout, jaringan, 5xx, 429). 404 dan sejenisnya bukan kegagalan.
// Redirect DIIKUTI MANUAL (bukan redirect:"follow"), supaya tiap loncatan dicek dulu hostname DAN hasil resolve DNS-nya:
// situs awal yang aman tetap bisa dipakai menyelinap ke jaringan internal lewat redirect kalau ini tidak dicek ulang tiap hop.
async function grab(url) {
  let cur = url;
  for (let hop = 0; hop < MAXHOPS; hop++) {
    let u;
    try { u = new URL(cur); } catch (e) { return { html: "", err: false }; }
    if (!/^https?:$/.test(u.protocol)) return { html: "", err: false };
    if (await hostBlocked(u.hostname)) return { html: "", err: false };
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 6000);
    try {
      const r = await fetch(u.href, { signal: c.signal, redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; hair-leads-demo/1.0)", "Accept": "text/html" } });
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
        try { cur = new URL(r.headers.get("location"), u).href; continue; } catch (e) { return { html: "", err: false }; }
      }
      if (!r.ok) return { html: "", err: r.status >= 500 || r.status === 429 };
      return { html: (await r.text()).slice(0, 600000), err: false };
    } catch (e) { return { html: "", err: true }; } finally { clearTimeout(t); }
  }
  return { html: "", err: false }; // terlalu banyak loncatan redirect
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
    const addEmail = m => { const t = tidyEmail(m); if (t.indexOf("@") > 0) found.add(t); };
    (text.match(/mailto:([^"'?>\s]+)/gi) || []).forEach(m => addEmail(m.slice(7)));
    (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).forEach(addEmail);
    for (const m of text.matchAll(WA)) wa.add(m[1]);
    if ([...found].some(e => !BAD.test(e)) && wa.size) break;
  }
  const score = e => (e.endsWith("@" + root) || e.endsWith("." + root) ? 0 : 2) + (/^(info|contact|hello|sales|enquiries|admin|cs)@/.test(e) ? 0 : 1);
  const emails = [...found].filter(e => !BAD.test(e)).sort((a, b) => score(a) - score(b)).slice(0, 3);
  return { emails, whatsapp: [...wa].slice(0, 2), failed };
}

module.exports = { findContacts, tidyEmail };
