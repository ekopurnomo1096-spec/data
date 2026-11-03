// Skor prospek berbasis aturan (tanpa AI): 0-100 dari data yang sudah ada. Ubah bobot di sini.
const FREE = /@(gmail|googlemail|yahoo|ymail|rocketmail|outlook|hotmail|live|msn|icloud|me|aol|proton|protonmail|gmx|mail|zoho)\.[a-z.]+$/i;
const STRONG = /\b(wig|wigs|extension|extensions|weave|weaves|braid|braids|beauty supply|hair supply|hair store|hair shop|wholesale)\b/i;
const WEAK = /\b(salon|hair|hairdresser|studio|beauty|barber|lash|boutique)\b/i;

// lead: {name, email, emails, website, phone, wa, rating, reviews}. Mengembalikan {s: 0-100, why: [alasan singkat]}
function scoreLead(l) {
  l = l || {};
  const why = [];
  let s = 0;
  const em = (Array.isArray(l.emails) && l.emails.length ? l.emails[0] : l.email) || "";
  if (em) { s += 30; why.push("ada email"); if (!FREE.test(em)) { s += 5; why.push("email domain sendiri"); } }
  if (l.website) { s += 10; why.push("ada website"); }
  if (l.wa) { s += 5; why.push("ada WhatsApp"); }
  if (l.phone) { s += 5; why.push("ada telepon"); }
  const rating = parseFloat(l.rating), reviews = parseInt(l.reviews, 10);
  if (rating >= 4.5) { s += 10; why.push("rating " + rating); } else if (rating >= 4) { s += 6; why.push("rating " + rating); } else if (rating >= 3.5) s += 3;
  if (reviews >= 100) { s += 10; why.push(reviews + " ulasan"); } else if (reviews >= 30) { s += 7; why.push(reviews + " ulasan"); } else if (reviews >= 10) s += 4;
  const name = String(l.name || "");
  if (STRONG.test(name)) { s += 15; why.push("nama cocok (wig/extension)"); } else if (WEAK.test(name)) { s += 8; why.push("nama cocok (salon/kecantikan)"); }
  return { s: Math.min(100, s), why };
}

module.exports = { scoreLead, FREE };
