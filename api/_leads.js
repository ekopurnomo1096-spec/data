// Pembantu prospek: kunci unik (id), penghapus duplikat, dan pembersih data sebelum disimpan.
const crypto = require("crypto");

const STATUSES = ["", "chat", "balas", "deal", "tidak", "kosong"]; // "" = belum dihubungi, "kosong" = Tanpa kontak (diisi otomatis oleh job cek kontak)

const norm = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, " ").trim();
const alnum = s => norm(s).replace(/ /g, "");

function placeKey(osm) {
  const u = String(osm || "");
  let m = u.match(/place_id:([^&\s]+)/);
  if (m) return "g:" + m[1];
  m = u.match(/openstreetmap\.org\/(node|way|relation)\/(\d+)/);
  if (m) return "o:" + m[1] + "/" + m[2];
  return "";
}
function phoneKey(p) {
  const d = String(p || "").split(/[;,]/)[0].replace(/\D/g, "");
  return d.length >= 8 ? d.slice(-9) : "";
}
function addrKey(r) {
  const n = alnum(r.name);
  return n ? n + "|" + alnum(r.address).slice(0, 30) : "";
}
function similar(a, b) {
  const x = new Set(norm(a).split(" ").filter(Boolean)), y = new Set(norm(b).split(" ").filter(Boolean));
  if (!x.size || !y.size) return false;
  let i = 0;
  x.forEach(t => { if (y.has(t)) i++; });
  return i / (x.size + y.size - i) >= 0.5;
}
function idFor(r) {
  const pk = placeKey(r.osm);
  if (pk) return pk;
  return "n:" + crypto.createHash("sha1").update(addrKey(r) || String(r.osm || r.name)).digest("hex").slice(0, 16);
}

// Dua baris dianggap duplikat jika: place_id / id OSM sama, ATAU nama dan alamat sama,
// ATAU nomor telepon sama dan namanya mirip. Cabang berbeda (alamat berbeda) tidak dibuang.
function dedupe(list) {
  const out = [], byPlace = new Map(), byAddr = new Map(), byPhone = new Map();
  let dupes = 0;
  for (const r of list) {
    const pk = placeKey(r.osm), ak = addrKey(r), ph = phoneKey(r.phone);
    let hit = null;
    if (pk && byPlace.has(pk)) hit = byPlace.get(pk);
    else if (ak && byAddr.has(ak)) hit = byAddr.get(ak);
    else if (ph && byPhone.has(ph)) hit = byPhone.get(ph).find(c => similar(c.name, r.name)) || null;
    if (hit) {
      for (const k of ["address", "phone", "website", "email", "thumbnail", "rating", "reviews", "osm"]) {
        if (!hit[k] && r[k]) hit[k] = r[k];
      }
      dupes++;
      continue;
    }
    r.id = idFor(r);
    out.push(r);
    if (pk) byPlace.set(pk, r);
    if (ak) byAddr.set(ak, r);
    if (ph) { if (!byPhone.has(ph)) byPhone.set(ph, []); byPhone.get(ph).push(r); }
  }
  return { list: out, dupes };
}

const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
function sanitizeLead(l) {
  l = l && typeof l === "object" ? l : {};
  const o = {
    id: str(l.id, 120), name: str(l.name, 200), address: str(l.address, 300), phone: str(l.phone, 100),
    website: str(l.website, 300), email: str(l.email, 200), thumbnail: str(l.thumbnail, 500),
    osm: str(l.osm, 300), wa: str(l.wa, 30), ctx: str(l.ctx, 200),
    rating: l.rating == null ? null : str(String(l.rating), 10),
    reviews: l.reviews == null ? null : str(String(l.reviews), 12),
    looked: !!l.looked, found: !!l.found,
    retry: Math.max(0, Math.min(2, parseInt(l.retry, 10) || 0)), rt: Math.max(0, Number(l.rt) || 0) // coba ulang cek website: jumlah gagal dan waktu gagal terakhir
  };
  o.emails = Array.isArray(l.emails) ? l.emails.slice(0, 5).map(e => str(e, 200)).filter(Boolean) : [];
  return o;
}

module.exports = { STATUSES, dedupe, sanitizeLead, placeKey };
