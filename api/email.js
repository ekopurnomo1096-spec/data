// Cari email dan WhatsApp dari website sebuah bisnis (gratis, tanpa API key)
const { isAuthed } = require("./_auth");
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

module.exports = async (req, res) => {
  try {
    if (!isAuthed(req)) return res.status(401).json({ error: "Belum login" });
    let u = String((req.query && req.query.url) || "").trim();
    if (!u) return res.status(400).json({ error: "url kosong" });
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    let base;
    try { base = new URL(u); } catch (e) { return res.status(400).json({ error: "url tidak valid" }); }
    if (blocked(base.hostname)) return res.status(400).json({ error: "alamat tidak diizinkan" });

    const root = base.hostname.replace(/^www\./, "");
    const found = new Set();
    const wa = new Set();
    for (const p of PATHS) {
      const html = await grab(p ? new URL(p, base).href : base.href);
      const text = html.replace(/&#0*64;|&commat;|\[at\]/gi, "@");
      (text.match(/mailto:([^"'?>\s]+)/gi) || []).forEach(m => found.add(m.slice(7).toLowerCase()));
      (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).forEach(m => found.add(m.toLowerCase()));
      for (const m of text.matchAll(WA)) wa.add(m[1]);
      if ([...found].some(e => !BAD.test(e)) && wa.size) break;
    }
    const score = e => (e.endsWith("@" + root) || e.endsWith("." + root) ? 0 : 2) + (/^(info|contact|hello|sales|enquiries|admin|cs)@/.test(e) ? 0 : 1);
    const emails = [...found].filter(e => !BAD.test(e)).sort((a, b) => score(a) - score(b)).slice(0, 3);
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.status(200).json({ emails, whatsapp: [...wa].slice(0, 2) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
