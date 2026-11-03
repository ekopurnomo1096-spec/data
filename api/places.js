// Vercel serverless function: cari tempat via OpenStreetMap (gratis, tanpa API key)
const FILTERS = {
  salon: 'nwr["shop"="hairdresser"]',
  beauty: 'nwr["shop"~"beauty|cosmetics"]',
  wig: 'nwr["name"~"wig|extension|rambut|hair|beauty supply",i]'
};
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
const UA = { "User-Agent": "hair-leads-demo/1.0 (contact: you@example.com)" };

async function getJSON(url, opts, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: c.signal });
    const tx = await r.text();
    try { return JSON.parse(tx); }
    catch (e) { throw new Error("balasan tidak valid dari " + new URL(url).host + " (" + r.status + ")"); }
  } catch (e) {
    if (e.name === "AbortError") throw new Error("waktu habis menghubungi " + new URL(url).host);
    throw e;
  } finally { clearTimeout(t); }
}

module.exports = async (req, res) => {
  try {
    const city = String((req.query && req.query.city) || "").trim();
    const kind = FILTERS[req.query && req.query.kind] ? req.query.kind : "salon";
    if (!city) return res.status(400).json({ error: "Isi nama kota" });

    // 1) Nama kota -> koordinat
    const g = await getJSON(
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(city),
      { headers: UA }, 8000
    );
    if (!Array.isArray(g) || !g.length) return res.status(404).json({ error: "Kota tidak ditemukan" });
    let [s, n, w, e] = g[0].boundingbox.map(Number);

    // 2) Batasi area (maks ±0,1 derajat, sekitar 11 km) supaya pencarian cepat
    const cy = (s + n) / 2, cx = (w + e) / 2;
    const hy = Math.min((n - s) / 2, 0.1), hx = Math.min((e - w) / 2, 0.1);
    s = cy - hy; n = cy + hy; w = cx - hx; e = cx + hx;

    const q = `[out:json][timeout:15];(${FILTERS[kind]}(${s},${w},${n},${e}););out center 100;`;
    let o = null, lastErr;
    for (const ep of OVERPASS) {
      try {
        o = await getJSON(ep, {
          method: "POST",
          headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(q)
        }, 18000);
        break;
      } catch (err) { lastErr = err; }
    }
    if (!o) throw lastErr;

    const results = (o.elements || []).map(x => {
      const t = x.tags || {};
      return {
        name: t.name || "",
        address: [t["addr:street"], t["addr:housenumber"], t["addr:city"]].filter(Boolean).join(" "),
        phone: t.phone || t["contact:phone"] || t["contact:whatsapp"] || "",
        website: t.website || t["contact:website"] || t["contact:instagram"] || "",
        email: t.email || t["contact:email"] || "",
        osm: "https://www.openstreetmap.org/" + x.type + "/" + x.id
      };
    }).filter(r => r.name);
    res.setHeader("Cache-Control", "s-maxage=3600");
    return res.status(200).json({ results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
