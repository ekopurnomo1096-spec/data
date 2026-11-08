// Skor prospek berbasis aturan (tanpa AI): 0-100 dari data yang sudah ada.
// Bobot bisa diubah dari halaman (tab Otomatis > Skor prospek). Nilai bawaan ada di DEFAULT_W di bawah.
// Sinyal positif menambah, sinyal negatif (bobot minus) mengurangi. Hasil akhir dijepit ke 0-100.
const FREE = /@(gmail|googlemail|yahoo|ymail|rocketmail|outlook|hotmail|live|msn|icloud|me|aol|proton|protonmail|gmx|mail|zoho)\.[a-z.]+$/i;
const STRONG = /\b(wig|wigs|extension|extensions|weave|weaves|braid|braids|beauty supply|hair supply|hair store|hair shop|wholesale)\b/i;
const WEAK = /\b(salon|hair|hairdresser|studio|beauty|boutique)\b/i;
// Sinyal negatif (kata di nama dan alamat email). Daftar kata ada di sini, bobotnya bisa diubah dari halaman.
const CHAIN = /\b(sally beauty|ulta|sephora|regis|supercuts|great clips|sport clips|fantastic sams|cost cutters|smartstyle|walmart|walgreens|cvs|rite aid|target|boots|superdrug|jcpenney|macy'?s)\b/i;
const OFFTOPIC = /\b(barber|barbers|barbershop|nail|nails|spa|tattoo|massage|lash|lashes|brow|brows|dental|dentist|clinic|school|college|university|pharmacy)\b/i;
const ROLEMAIL = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|abuse|privacy|legal|webmaster|security|billing|unsubscribe|careers|jobs|hr|press|media)(\b|[._+-])/i;
const SOCIAL = /(^|\.)(facebook|instagram|linktr|linktree|tiktok|youtube|twitter|x|wa|whatsapp|yelp|google|business\.site)\.[a-z.]+$/i;

// key: [nilai bawaan, label, kelompok]. Kelompok "neg" = sinyal negatif (bawaan minus).
const DEFS = {
  email:    [30,  "Ada email", "pos"],
  website:  [10,  "Ada website", "pos"],
  wa:       [5,   "Ada WhatsApp", "pos"],
  phone:    [5,   "Ada telepon", "pos"],
  r45:      [10,  "Rating 4,5 ke atas", "pos"],
  r40:      [6,   "Rating 4,0 sampai 4,4", "pos"],
  r35:      [3,   "Rating 3,5 sampai 3,9", "pos"],
  v100:     [10,  "Ulasan 100 ke atas", "pos"],
  v30:      [7,   "Ulasan 30 sampai 99", "pos"],
  v10:      [4,   "Ulasan 10 sampai 29", "pos"],
  strong:   [15,  "Nama memuat wig / extension / weave / beauty supply / wholesale", "pos"],
  weak:     [8,   "Nama memuat salon / hair / beauty / studio", "pos"],
  chain:    [-50, "Jaringan besar (Sally Beauty, Ulta, Walmart dll), biasanya beli lewat pusat", "neg"],
  offtopic: [-15, "Bukan bisnis rambut (barber, nail, spa, tattoo, klinik, sekolah dll)", "neg"],
  roleMail: [-15, "Email tidak dibaca orang (noreply, abuse, privacy, legal dll)", "neg"],
  lowRate:  [-10, "Rating di bawah 3,0 dengan 10 ulasan atau lebih", "neg"],
  fewRev:   [-3,  "Hampir tanpa ulasan (kurang dari 3) padahal ada rating", "neg"],
  social:   [-5,  "Website hanya halaman media sosial (Facebook, Instagram dll)", "neg"]
};
const KEYS = Object.keys(DEFS);
const DEFAULT_W = {};
KEYS.forEach(k => { DEFAULT_W[k] = DEFS[k][0]; });

// Rapikan bobot dari halaman: hanya kunci yang dikenal, bilangan bulat -100..100. Sinyal positif tidak boleh minus
// dan sinyal negatif tidak boleh plus (salah ketik tanda minus tidak membalik arah skor). Yang kosong/rusak memakai bawaan.
function normWeights(w) {
  w = w && typeof w === "object" ? w : {};
  const out = {};
  for (const k of KEYS) {
    const raw = w[k];
    let v = raw === "" || raw == null ? NaN : Math.round(Number(raw));
    if (!isFinite(v)) { out[k] = DEFAULT_W[k]; continue; }
    v = Math.max(-100, Math.min(100, v));
    out[k] = DEFS[k][2] === "neg" ? -Math.abs(v) : Math.abs(v);
  }
  return out;
}

const host = u => { try { return new URL(/^https?:\/\//i.test(u) ? u : "https://" + u).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { return ""; } };

// lead: {name, email, emails, website, phone, wa, rating, reviews}; w: bobot (opsional, bawaan DEFAULT_W).
// Mengembalikan {s: 0-100, why: [alasan positif], neg: [alasan negatif], parts: {kunci: poin}}
function scoreLead(l, w) {
  l = l || {};
  w = w ? normWeights(w) : DEFAULT_W;
  const why = [], neg = [], parts = {};
  let s = 0;
  const add = (k, text, show) => {
    const p = w[k];
    if (!p) return;
    s += p; parts[k] = p;
    if (show === false) return;
    (p < 0 ? neg : why).push(text);
  };
  const em = String((Array.isArray(l.emails) && l.emails.length ? l.emails[0] : l.email) || "").trim().toLowerCase();
  if (em) {
    add("email", "ada email");
    if (ROLEMAIL.test(em.split("@")[0])) add("roleMail", "email tidak dibaca orang (" + em.split("@")[0] + ")");
  }
  if (l.website) {
    add("website", "ada website");
    const h = host(l.website);
    if (h && SOCIAL.test(h)) add("social", "website hanya media sosial");
  }
  if (l.wa) add("wa", "ada WhatsApp");
  if (l.phone) add("phone", "ada telepon");
  const rating = parseFloat(l.rating), reviews = parseInt(String(l.reviews == null ? "" : l.reviews).replace(/[^\d]/g, ""), 10);
  if (rating >= 4.5) add("r45", "rating " + rating);
  else if (rating >= 4) add("r40", "rating " + rating);
  else if (rating >= 3.5) add("r35", "rating " + rating, false);
  if (reviews >= 100) add("v100", reviews + " ulasan");
  else if (reviews >= 30) add("v30", reviews + " ulasan");
  else if (reviews >= 10) add("v10", reviews + " ulasan", false);
  if (rating > 0 && rating < 3 && reviews >= 10) add("lowRate", "rating rendah " + rating);
  if (rating > 0 && reviews < 3) add("fewRev", "hampir tanpa ulasan");
  const name = String(l.name || "");
  const isStrong = STRONG.test(name);
  if (CHAIN.test(name)) add("chain", "jaringan besar");
  if (isStrong) add("strong", "nama cocok (wig/extension)");
  else if (OFFTOPIC.test(name)) add("offtopic", "bukan bisnis rambut");
  else if (WEAK.test(name)) add("weak", "nama cocok (salon/kecantikan)");
  return { s: Math.max(0, Math.min(100, s)), why, neg, parts };
}

module.exports = { scoreLead, normWeights, FREE, DEFS, DEFAULT_W, KEYS };
