// Vercel serverless function: cari tempat via OpenStreetMap (gratis, tanpa kartu kredit, tanpa API key)
const FILTERS = {
  salon: 'nwr["shop"="hairdresser"]',
  beauty: 'nwr["shop"~"beauty|cosmetics"]',
  wig: 'nwr["name"~"wig|extension|rambut|hair|beauty supply",i]'
};

module.exports = async (req, res) => {
  const city = String(req.query.city || "").trim();
  const kind = FILTERS[req.query.kind] ? req.query.kind : "salon";
  if (!city) return res.status(400).json({ error: "Isi nama kota (boleh luar negeri, mis. "Houston, USA")" });
  try {
    // 1) Nominatim: nama kota -> kotak koordinat
    const g = await fetch(
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(city),
      { headers: { "User-Agent": "hair-leads-demo/1.0" } }
    ).then(r => r.json());
    if (!g.length) return res.status(404).json({ error: "Kota tidak ditemukan" });
    const [s, n, w, e] = g[0].boundingbox; // south, north, west, east
    // 2) Overpass: ambil tempat di dalam kotak
    const q = `[out:json][timeout:25];(${FILTERS[kind]}(${s},${w},${n},${e}););out center 100;`;
    const o = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "User-Agent": "hair-leads-demo/1.0", "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(q)
    }).then(r => r.json());
    const results = (o.elements || []).map(x => {
      const t = x.tags || {};
      return {
        name: t.name || "(tanpa nama)",
        address: [t["addr:street"], t["addr:housenumber"], t["addr:city"]].filter(Boolean).join(" "),
        phone: t.phone || t["contact:phone"] || t["contact:whatsapp"] || "",
        website: t.website || t["contact:website"] || t["contact:instagram"] || "",
        email: t.email || t["contact:email"] || "",
        osm: "https://www.openstreetmap.org/" + x.type + "/" + x.id
      };
    }).filter(r => r.name !== "(tanpa nama)");
    res.setHeader("Cache-Control", "s-maxage=3600");
    res.status(200).json({ results });
  } catch (err) {
    res.status(500).json({ error: "Gagal mengambil data (" + err.message + ")" });
  }
};
