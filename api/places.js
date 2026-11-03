// Vercel serverless function: cari tempat via OpenStreetMap (gratis, tanpa API key)
const FILTERS = {
  salon: 'nwr["shop"="hairdresser"]',
  beauty: 'nwr["shop"~"beauty|cosmetics"]',
  wig: 'nwr["name"~"wig|extension|rambut|hair|beauty supply",i]'
};
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
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

// ---- Sumber utama: Geoapify (gratis, tanpa kartu kredit, perlu API key) ----
const GEO_CATS = {
  salon: ["service.beauty.hairdresser", "service.beauty"],
  beauty: ["commercial.health_and_beauty"]
};

function mapGeo(f) {
  const p = f.properties || {}, c = p.contact || {}, raw = (p.datasource && p.datasource.raw) || {};
  return {
    name: p.name || "",
    address: (p.formatted || "").replace((p.name || "") + ", ", ""),
    phone: c.phone || raw.phone || "",
    website: p.website || c.website || raw.website || "",
    email: c.email || raw.email || "",
    osm: "https://www.openstreetmap.org/?mlat=" + p.lat + "&mlon=" + p.lon + "#map=18/" + p.lat + "/" + p.lon
  };
}

async function geoSearch(pt, kind, key) {
  const base = "https://api.geoapify.com/v2/places?limit=100&filter=circle:" + pt.lon + "," + pt.lat +
    ",8000&bias=proximity:" + pt.lon + "," + pt.lat + "&apiKey=" + encodeURIComponent(key);
  const tries = kind === "wig"
    ? ["&categories=commercial,service.beauty&name=wig"]
    : GEO_CATS[kind].map(c => "&categories=" + c);
  let last;
  for (const t of tries) {
    try {
      const j = await getJSON(base + t, { headers: UA }, 15000);
      if (j.features) return j.features.map(mapGeo).filter(r => r.name);
      last = new Error(j.message || j.error || "balasan Geoapify tidak dikenal");
    } catch (e) { last = e; }
  }
  throw last;
}

// ---- Cadangan jika GEOAPIFY_KEY belum diisi: Overpass (sering tidak stabil) ----
async function overpassSearch(pt, kind) {
  const s = pt.lat - 0.07, n = pt.lat + 0.07, w = pt.lon - 0.07, e = pt.lon + 0.07;
  const q = `[out:json][timeout:25];(${FILTERS[kind]}(${s},${w},${n},${e}););out center 100;`;
  let o;
  try {
    o = await Promise.any(OVERPASS.map(ep => getJSON(ep, {
      method: "POST",
      headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(q)
    }, 28000)));
  } catch (agg) {
    throw new Error("server peta sedang sibuk. Isi GEOAPIFY_KEY di Vercel agar lebih stabil (" +
      (agg.errors || []).map(x => x.message).join("; ") + ")");
  }
  return (o.elements || []).map(x => {
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
}

// ---- Google Maps lewat SerpApi (data paling lengkap; butuh SERPAPI_KEY) ----
const SERP_TERM = { salon: "hair extension salon", wig: "wig shop", beauty: "beauty supply store" };

async function serpSearch(city, kind, key) {
  const url = "https://serpapi.com/search.json?engine=google_maps&type=search&q=" +
    encodeURIComponent(SERP_TERM[kind] + " in " + city) + "&api_key=" + encodeURIComponent(key);
  const j = await getJSON(url, { headers: UA }, 25000);
  if (j.error) {
    if (/hasn't returned any results/i.test(j.error)) return [];
    throw new Error("SerpApi: " + j.error);
  }
  const list = j.local_results || (j.place_results ? [j.place_results] : []);
  return list.map(r => ({
    name: r.title || "",
    address: r.address || "",
    phone: r.phone || "",
    website: r.website || "",
    email: "",
    thumbnail: r.thumbnail || "",
    rating: r.rating || null,
    reviews: r.reviews || null,
    osm: r.place_id ? "https://www.google.com/maps/place/?q=place_id:" + r.place_id : ""
  })).filter(r => r.name);
}

module.exports = async (req, res) => {
  try {
    const city = String((req.query && req.query.city) || "").trim();
    const kind = FILTERS[req.query && req.query.kind] ? req.query.kind : "salon";
    if (!city) return res.status(400).json({ error: "Isi nama kota" });
    let results;
    if (req.query.source === "osm") {
      const pt = await geocode(city);
      if (!pt) return res.status(404).json({ error: "Kota tidak ditemukan" });
      const key = process.env.GEOAPIFY_KEY;
      results = key ? await geoSearch(pt, kind, key) : await overpassSearch(pt, kind);
    } else {
      const key = process.env.SERPAPI_KEY;
      if (!key) return res.status(500).json({ error: "SERPAPI_KEY belum diisi di Vercel (Settings > Environment Variables), lalu Redeploy" });
      results = await serpSearch(city, kind, key);
    }
    res.setHeader("Cache-Control", "s-maxage=3600");
    return res.status(200).json({ results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
