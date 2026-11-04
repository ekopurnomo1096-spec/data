// Dasbor (hanya baca): corong prospek, perbandingan variasi A/B, tren harian. Perlu login.
// GET ?days=7|14|30|90   (bawaan 30; menentukan jendela untuk variasi dan tren. Corong selalu seluruh data tersimpan.)
// Tidak menulis apa pun ke Redis dan tidak memakai kuota SerpApi/Resend.
const { isAuthed } = require("./_auth");
const { dbConfigured, hgetall } = require("./_store");
const M = require("./_mail");
const J = require("./_jobs");
const R = require("./_reply");

const MIN_SENT = 30; // di bawah ini, variasi dianggap belum cukup data

const emailOf = x => {
  const e = (x.emails && x.emails.length ? x.emails[0] : x.email) || "";
  const t = String(e).trim().toLowerCase();
  return M.EMAIL.test(t) ? t : "";
};
const titleCase = s => String(s || "").replace(/\s+/g, " ").trim().replace(/(^|[\s,-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
function countryOf(city) {
  const p = String(city || "").split(",").map(x => x.trim()).filter(Boolean);
  return p.length > 1 ? p[p.length - 1] : "(tanpa negara)";
}
const blank = () => ({ found: 0, contact: 0, emailed: 0, replied: 0, deal: 0 });

// Uji dua proporsi (z), satu arah, tanpa pustaka. Mengembalikan p-value kasar.
function pValue(a, b) {
  const n1 = a.sent, n2 = b.sent;
  if (n1 < MIN_SENT || n2 < MIN_SENT) return null;
  const p1 = a.rep / n1, p2 = b.rep / n2, pp = (a.rep + b.rep) / (n1 + n2);
  const se = Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2));
  if (!se) return 1;
  const z = (p1 - p2) / se;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? tail : 1 - tail;
}

function variants(stats) {
  const sent = {}, rep = {};
  stats.forEach(x => {
    Object.keys(x.v || {}).forEach(k => { sent[k] = (sent[k] || 0) + x.v[k]; });
    Object.keys(x.rv || {}).forEach(k => { rep[k] = (rep[k] || 0) + x.rv[k]; });
  });
  const stages = {};
  Object.keys(sent).forEach(k => {
    const m = /^s(\d+)v(\d+)$/.exec(k); if (!m) return;
    const st = +m[1], v = +m[2], r = rep["r" + st + "v" + v] || 0;
    (stages[st] || (stages[st] = [])).push({ v, sent: sent[k], rep: r, rate: sent[k] ? r / sent[k] : 0 });
  });
  return Object.keys(stages).map(Number).sort((a, b) => a - b).map(st => {
    const rows = stages[st].sort((a, b) => a.v - b.v);
    let verdict = "none", lead = -1;
    const ok = rows.filter(r => r.sent >= MIN_SENT);
    if (rows.length < 2) verdict = "single";
    else if (ok.length < 2) verdict = "thin";
    else {
      const o = ok.slice().sort((a, b) => b.rate - a.rate);
      const p = pValue(o[0], o[1]);
      if (o[0].rate === o[1].rate || o[0].rep === 0) verdict = "unclear";
      else if (p != null && p < 0.1) { verdict = "lead"; lead = o[0].v; }
      else verdict = "unclear";
    }
    return { stage: st, rows, verdict, lead };
  });
}

async function build(days) {
  const stats = await M.getStats(days);
  const data = await J.loadData();
  const mail = await hgetall(M.MAIL);
  const seq = await hgetall(J.SEQ);
  const replies = await R.listReplies(2000);
  const meta = await hgetall("hairleads:cmeta"); // nama kota asli (kunci cache disimpan huruf kecil)
  const cityName = key => {
    const m = M.parse(meta[key]);
    return m && m.city ? String(m.city).replace(/\s+/g, " ").trim() : titleCase(String(key).split("|").slice(2).join("|"));
  };

  const repById = {}, cats = {};
  const since = Date.now() - days * 864e5;
  replies.forEach(r => {
    if (r.t >= since) cats[r.cat] = (cats[r.cat] || 0) + 1;
    if (r.id && r.cat !== "auto_reply" && r.cat !== "unsubscribe") repById[r.id] = 1;
  });

  const total = blank(), byCity = {}, byCountry = {}, seen = new Set();
  for (const e of data.entries) {
    const city = cityName(e.key), country = countryOf(city);
    for (const r of e.results) {
      if (!r || !r.id || seen.has(r.id)) continue; // satu tempat dihitung sekali, di pencarian pertama yang memuatnya
      seen.add(r.id);
      const x = data.map.get(r.id) || r, st = (data.leads[r.id] && data.leads[r.id].s) || "";
      const contact = !!(emailOf(x) || x.wa);
      const emailed = !!(mail[r.id] || seq[r.id] || st);
      const replied = !!(repById[r.id] || st === "balas" || st === "deal");
      const deal = st === "deal";
      [total, byCity[city] || (byCity[city] = blank()), byCountry[country] || (byCountry[country] = blank())].forEach(o => {
        o.found++; if (contact) o.contact++; if (emailed) o.emailed++; if (replied) o.replied++; if (deal) o.deal++;
      });
    }
  }
  const rank = o => Object.keys(o).map(k => ({ name: k, ...o[k] }))
    .sort((a, b) => (b.replied - a.replied) || (b.emailed - a.emailed) || (b.found - a.found));

  const trend = stats.slice().reverse().map(x => ({ d: x.d, sent: x.sent, fu: x.fu, reply: x.reply, bounce: x.bounce, spam: x.spam, unsub: x.unsub, added: x.added, found: x.found }));
  const win = stats.reduce((a, x) => ({ sent: a.sent + x.sent + x.fu, reply: a.reply + x.reply, bounce: a.bounce + x.bounce, spam: a.spam + x.spam, unsub: a.unsub + x.unsub }), { sent: 0, reply: 0, bounce: 0, spam: 0, unsub: 0 });

  return {
    days, minSent: MIN_SENT, funnel: total, window: win, cats,
    countries: rank(byCountry).slice(0, 15), cities: rank(byCity).slice(0, 30), cityCount: Object.keys(byCity).length,
    variants: variants(stats), trend
  };
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "private, no-store");
    if (!isAuthed(req)) return res.status(401).json({ error: "Belum login" });
    if (!dbConfigured()) return res.status(200).json({ nodb: true });
    if (req.method !== "GET") return res.status(405).json({ error: "metode tidak didukung" });
    const d = parseInt(req.query && req.query.days, 10);
    const days = [7, 14, 30, 90].includes(d) ? d : 30;
    return res.status(200).json(await build(days));
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
};
