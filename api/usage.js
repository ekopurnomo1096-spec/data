// Sisa kuota SerpApi (Account API SerpApi, gratis dan tidak mengurangi kuota pencarian)
const { isAuthed } = require("./_auth");
const { getKey } = require("./_store");

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "private, no-store");
    if (!isAuthed(req)) return res.status(401).json({ error: "Belum login" });
    const key = (await getKey("serp")) || process.env.SERPAPI_KEY;
    if (!key) return res.status(200).json({ available: false });
    const r = await fetch("https://serpapi.com/account.json?api_key=" + encodeURIComponent(key),
      { headers: { "User-Agent": "hair-leads-demo/1.0" }, signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error || j.searches_per_month == null) return res.status(200).json({ available: false, error: j.error || ("HTTP " + r.status) });
    const limit = Number(j.searches_per_month) || 0;
    const used = Number(j.this_month_usage) || 0;
    const left = j.total_searches_left != null ? Number(j.total_searches_left) : Math.max(limit - used, 0);
    return res.status(200).json({ available: true, used, limit, left, plan: j.plan_name || "" });
  } catch (err) {
    return res.status(200).json({ available: false, error: err.message });
  }
};
