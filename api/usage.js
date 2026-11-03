// Sisa kuota SerpApi untuk tiap akun (Account API SerpApi, gratis dan tidak mengurangi kuota pencarian)
const { isAuthed } = require("./_auth");
const { getKey } = require("./_store");

async function account(key, label) {
  try {
    const r = await fetch("https://serpapi.com/account.json?api_key=" + encodeURIComponent(key),
      { headers: { "User-Agent": "hair-leads-demo/1.0" }, signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error || j.searches_per_month == null) return null;
    const limit = Number(j.searches_per_month) || 0;
    const used = Number(j.this_month_usage) || 0;
    const left = j.total_searches_left != null ? Number(j.total_searches_left) : Math.max(limit - used, 0);
    return { label, used, limit, left };
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "private, no-store");
    if (!isAuthed(req)) return res.status(401).json({ error: "Belum login" });
    const [k1, k2] = await Promise.all([getKey("serp"), getKey("serp2")]);
    const keys = [k1 || process.env.SERPAPI_KEY, k2].filter(Boolean);
    const out = (await Promise.all(keys.map((k, i) => account(k, "Akun " + (i + 1))))).filter(Boolean);
    return res.status(200).json({ accounts: out });
  } catch (err) {
    return res.status(200).json({ accounts: [], error: err.message });
  }
};
