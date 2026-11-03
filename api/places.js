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
const UA = { "User-Agent": "hair-leads-demo/1.0" };

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

const ALIAS = { usa: "US", us: "US", amerika: "US", "amerika serikat": "US", uk: "GB", inggris: "GB",
  "united kingdom": "GB", nigeria: "NG", indonesia: "ID", "afrika selatan": "ZA", "south africa": "ZA" };

// Nama kota -> koordinat. Open-Meteo dulu, Photon sebagai cadangan (keduanya gratis, tanpa key)
async function geocode(city) {
  const parts = city.split(",").map(x => x.trim()).filter(Boolean);
  const hint = (parts[1] || "").toLowerCase();
  try {
    const g = await getJSON(
      "https://geocoding-api.open-meteo.com/v1/search?count=10&language=en&format=json&name=" + encodeURIComponent(parts[0]),
      { headers: UA }, 8000
    );
    const list = g.results || [];
    if (list.length) {
      let pick = list[0];
      if (hint) {
        const cc = ALIAS[hint];
        const m = list.find(x => (cc && x.country_code === cc) ||
          (x.country || "").toLowerCase().includes(hint) || (x.admin1 || "").toLowerCase().includes(hint));
        if (m) pick = m;
      }
      return { lat: pick.latitude, lon: pick.longitude };
    }
  } catch (e) { /* lanjut ke cadangan */ }
  const p = await getJSON("https://photon.komoot.io/api/?limit=1&q=" + encodeURIComponent(city), { headers: UA }, 8000);
  const f = p.features && p.features[0];
  return f ? { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] } : null;
}

module.exports = async (req, res) => {
  try {
    const city = String((req.query && req.query.city) || "").trim();
    const kind = FILTERS[req.query && req.query.kind] ? req.query.kind : "salon";
    if (!city) return res.status(400).json({ error: "Isi nama kota" });

    // 1) Nama kota -> koordinat, lalu kotak pencarian ±0,1 derajat (sekitar 11 km)
    const pt = await geocode(city);
    if (!pt) return res.status(404).json({ error: "Kota tidak ditemukan" });
    const s = pt.lat - 0.1, n = pt.lat + 0.1, w = pt.lon - 0.1, e = pt.lon + 0.1;

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
