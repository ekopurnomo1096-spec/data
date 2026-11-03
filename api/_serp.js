// Pemilih akun SerpApi. Memilih akun yang dipakai untuk satu pencarian, dan pindah otomatis ke akun lain
// kalau sisa kuota akun aktif di bawah batas (pengaturan cfg.serp di hairleads:auto).
// Cek kuota memakai Account API SerpApi (gratis, tidak mengurangi kuota pencarian).
const { getKey, getActive, setActive, cmd, dbConfigured } = require("./_store");

const AUTO = "hairleads:auto";
const UA = { "User-Agent": "hair-leads-demo/1.0" };
const DEFAULT = { auto: true, below: 20 };

function sanitizeSerp(s) {
  s = s && typeof s === "object" ? s : {};
  let b = Math.round(Number(s.below));
  if (!isFinite(b)) b = DEFAULT.below;
  return { auto: typeof s.auto === "boolean" ? s.auto : DEFAULT.auto, below: Math.max(0, Math.min(1000, b)) };
}
async function getSerpCfg() {
  if (!dbConfigured()) return { ...DEFAULT };
  try {
    const raw = await cmd(["HGET", AUTO, "cfg"]);
    const c = raw ? JSON.parse(raw) : {};
    return sanitizeSerp(c && c.serp);
  } catch (e) { return { ...DEFAULT }; }
}

// Sisa kuota satu akun, atau null kalau tidak bisa dicek
async function leftOf(key) {
  try {
    const r = await fetch("https://serpapi.com/account.json?api_key=" + encodeURIComponent(key),
      { headers: UA, signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error || j.searches_per_month == null) return null;
    return j.total_searches_left != null ? Number(j.total_searches_left)
      : Math.max((Number(j.searches_per_month) || 0) - (Number(j.this_month_usage) || 0), 0);
  } catch (e) { return null; }
}

async function logSwitch(from, to, why, left) {
  const info = { t: Date.now(), from, to, why, left };
  if (dbConfigured()) { try { await cmd(["HSET", AUTO, "serpsw", JSON.stringify(info)]); } catch (e) { /* abaikan */ } }
  return info;
}

// Mengembalikan null kalau tidak ada key sama sekali. Selain itu:
// {n, key, left, auto, other: {n, key} | null, switched: {from, to, why, left} | null}
async function pickSerp() {
  const [k1, k2, act, cfg] = await Promise.all([getKey("serp"), getKey("serp2"), getActive(), getSerpCfg()]);
  const a1 = k1 || process.env.SERPAPI_KEY;
  if (!a1 && !k2) return null;
  const accts = [a1 && { n: 1, key: a1 }, k2 && { n: 2, key: k2 }].filter(Boolean);
  let cur = accts.find(a => String(a.n) === act) || accts[0];
  const other = accts.find(a => a.n !== cur.n) || null;
  const out = { n: cur.n, key: cur.key, left: null, auto: !!(cfg.auto && other), other, below: cfg.below, switched: null };
  if (!other) { out.left = await leftOf(cur.key); return out; }
  if (!cfg.auto) { out.left = await leftOf(cur.key); return out; }
  const [lc, lo] = await Promise.all([leftOf(cur.key), leftOf(other.key)]);
  out.left = lc;
  // Pindah hanya kalau akun aktif terbaca dan di bawah batas, dan akun lain terbaca dan lebih banyak sisanya
  if (lc !== null && lc < cfg.below && lo !== null && lo > lc) {
    out.switched = await logSwitch(cur.n, other.n, "kuota", lc);
    try { await setActive(String(other.n)); } catch (e) { /* tetap pakai akun lain untuk pencarian ini */ }
    out.n = other.n; out.key = other.key; out.left = lo;
    out.other = { n: cur.n, key: cur.key };
  }
  return out;
}

// Pindah ke akun lain setelah akun yang dipakai gagal karena kuota habis / key bermasalah
async function switchAfterError(sp) {
  if (!sp || !sp.other) return null;
  const info = await logSwitch(sp.n, sp.other.n, "error", null);
  try { await setActive(String(sp.other.n)); } catch (e) { /* abaikan */ }
  return info;
}
const EXHAUSTED = /out of searches|searches? left|run out|limit|quota|exceeded|plan|invalid api key|too many requests|429|401|403/i;

module.exports = { pickSerp, switchAfterError, getSerpCfg, sanitizeSerp, leftOf, EXHAUSTED, DEFAULT };
