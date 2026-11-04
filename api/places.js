// Vercel serverless function: cari tempat. API key diambil dari database (diisi lewat Pengaturan), cadangan: env Vercel
const { isAuthed } = require("./_auth");
const { getKey, dbConfigured, cmd } = require("./_store");
const { pickSerp, switchAfterError, EXHAUSTED } = require("./_serp");
const { dedupe } = require("./_leads");
const CACHE = "hairleads:cache", META = "hairleads:cmeta";
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
    throw new Error("server peta sedang sibuk. Isi key Geoapify di Pengaturan agar lebih stabil (" +
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

async function serpSearch(city, kind, key, start, ll) {
  let url = "https://serpapi.com/search.json?engine=google_maps&type=search&q=" +
    encodeURIComponent(SERP_TERM[kind] + " in " + city) + "&api_key=" + encodeURIComponent(key);
  if (start > 0) url += "&start=" + start + (ll ? "&ll=" + encodeURIComponent(ll) : "");
  const j = await getJSON(url, { headers: UA }, 25000);
  if (j.error) {
    if (/hasn't returned any results/i.test(j.error)) return { list: [], more: false, ll: ll || "" };
    throw new Error("SerpApi: " + j.error);
  }
  const raw = j.local_results || (j.place_results ? [j.place_results] : []);
  // Koordinat pencarian (ll) dari tautan halaman berikutnya, supaya halaman 2 dst konsisten
  const nx = (j.serpapi_pagination && j.serpapi_pagination.next) || "";
  const m = /[?&]ll=([^&]+)/.exec(nx);
  const llOut = m ? decodeURIComponent(m[1]) : (ll || "");
  const more = !!nx || raw.length >= 20;
  const list = raw.map(r => ({
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
  return { list, more, ll: llOut };
}

// Kunci cache sebuah pencarian (sama dengan yang dipakai searchCore). Dipakai putaran kota untuk tahu mana yang sudah pernah dicari.
function cacheKey(city, kind, source) {
  return (source === "osm" ? "osm" : "google") + "|" + (FILTERS[kind] ? kind : "salon") + "|" + String(city || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Inti pencarian, dipakai rute di bawah dan pekerjaan otomatis (_jobs.js).
// q: {city, kind, source:"google"|"osm", start, refresh}. opts.merge: pencarian baru digabung ke hasil tersimpan (bukan menggantikan).
// Melempar Error (dengan properti status kalau perlu) kalau gagal.
async function searchCore(q, opts) {
  opts = opts || {};
  const city = String(q.city || "").trim();
  const kind = FILTERS[q.kind] ? q.kind : "salon";
  const fail = (m, status) => { const e = new Error(m); if (status) e.status = status; return e; };
  if (!city) throw fail("Isi nama kota", 400);
  const source = q.source === "osm" ? "osm" : "google";
  const ckey = source + "|" + kind + "|" + city.toLowerCase().replace(/\s+/g, " ");
  const refresh = !!q.refresh;
  // start > 0: ambil halaman berikutnya (20 tempat per halaman), hanya untuk sumber Google
  const start = source === "google" ? Math.min(Math.max(parseInt(q.start, 10) || 0, 0), 400) : 0;

  // Hasil yang pernah disimpan dipakai lagi, jadi tidak memakai kuota SerpApi
  if (!refresh && !start && dbConfigured()) {
    try {
      const raw = await cmd(["HGET", CACHE, ckey]);
      const hit = raw && JSON.parse(raw);
      if (hit && Array.isArray(hit.results) && hit.results.length) {
        return { results: hit.results, cached: true, savedAt: hit.at, dupes: hit.dupes || 0, more: !!hit.more, next: hit.next || 0 };
      }
    } catch (e) { /* cache rusak atau Redis bermasalah: cari seperti biasa */ }
  }
  // cacheonly: hanya membaca hasil tersimpan (dipakai menu WhatsApp), tidak pernah memakai kuota SerpApi
  if (q.cacheonly) return { results: [], cached: true, empty: true };

  let results, more = false, ll = "", prev = [], prevDupes = 0, hit = null, acct = 0, switched = null, pageMore = false;
  if ((start > 0 || opts.merge) && dbConfigured()) {
    try {
      const raw = await cmd(["HGET", CACHE, ckey]);
      hit = raw && JSON.parse(raw);
      if (hit && Array.isArray(hit.results)) { prev = hit.results; ll = hit.ll || ""; prevDupes = hit.dupes || 0; } else hit = null;
    } catch (e) { hit = null; /* tanpa cache: halaman tambahan tetap diambil, hanya tidak digabung */ }
  }
  if (source === "osm") {
    const pt = await geocode(city);
    if (!pt) throw fail("Kota tidak ditemukan", 404);
    const key = (await getKey("geo")) || process.env.GEOAPIFY_KEY;
    results = key ? await geoSearch(pt, kind, key) : await overpassSearch(pt, kind);
  } else {
    // Akun dipilih lewat _serp.js: akun aktif (switch di pojok kanan atas), dan pindah otomatis
    // kalau sisa kuotanya di bawah batas (Pengaturan otomatis > Akun SerpApi).
    const sp = await pickSerp();
    if (!sp) throw fail("API key SerpApi belum diisi. Buka Pengaturan lalu masukkan key-nya");
    const two = !!sp.other || !!sp.switched;
    acct = sp.n; switched = sp.switched;
    try {
      const sr = await serpSearch(city, kind, sp.key, start, ll);
      results = sr.list; more = sr.more; ll = sr.ll; pageMore = sr.more;
    } catch (e) {
      // Kuota akun ini habis atau key bermasalah: coba sekali dengan akun lain (kalau pindah otomatis menyala)
      if (sp.auto && sp.other && EXHAUSTED.test(e.message)) {
        try {
          const sr = await serpSearch(city, kind, sp.other.key, start, ll);
          results = sr.list; more = sr.more; ll = sr.ll; pageMore = sr.more;
          switched = await switchAfterError(sp);
          acct = sp.other.n;
        } catch (e2) { throw new Error(e2.message + " (Akun " + sp.other.n + ")"); }
      } else throw two ? new Error(e.message + " (Akun " + sp.n + ")") : e;
    }
  }
  const pageN = results.length; // isi mentah satu halaman, sebelum dibuang duplikatnya
  const before = prev.length;
  const d = dedupe(prev.concat(results));
  results = d.list;
  d.dupes += prevDupes;
  const added = (start > 0 || hit) ? results.length - before : results.length;
  if (start > 0 && added <= 0) more = false;
  let next = more ? (start || 0) + 20 : 0;
  // Gabung tanpa memuat halaman lanjutan: penunjuk "Muat 20 lagi" tetap seperti semula
  if (opts.merge && !start && hit) { more = !!hit.more; next = hit.next || 0; ll = hit.ll || ll; }
  // Gabung halaman 2-3 saat cari ulang otomatis: jangan memundurkan penunjuk kalau halaman lebih jauh sudah pernah dimuat
  if (opts.merge && start > 0 && hit && (hit.next || 0) > next) { more = !!hit.more; next = hit.next; }
  let saved = false;
  if (results.length && dbConfigured()) {
    try {
      const at = Date.now();
      await cmd(["HSET", CACHE, ckey, JSON.stringify({ at, dupes: d.dupes, results, more, next, ll })]);
      await cmd(["HSET", META, ckey, JSON.stringify({ at, city, kind, source, n: results.length })]);
      saved = true;
    } catch (e) { /* gagal menyimpan tidak boleh menggagalkan pencarian */ }
  }
  return { results, cached: false, saved, dupes: d.dupes, more, next, added, pageN, pageMore, acct, switched };
}

module.exports = async (req, res) => {
  try {
    if (!isAuthed(req)) return res.status(401).json({ error: "Belum login" });
    res.setHeader("Cache-Control", "private, no-store");
    const qy = req.query || {};
    const out = await searchCore({ city: qy.city, kind: qy.kind, source: qy.source, start: qy.start, refresh: qy.refresh === "1", cacheonly: qy.cacheonly === "1" });
    return res.status(200).json(out);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
};
module.exports.searchCore = searchCore;
module.exports.cacheKey = cacheKey;
