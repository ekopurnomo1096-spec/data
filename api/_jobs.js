// Pekerjaan otomatis: dijalankan oleh cron harian (api/auto.js?a=cron) atau tombol "Jalankan sekarang" di tab Otomatis.
//   mail    : kirim follow-up yang sudah waktunya + email pertama yang sudah disetujui (sesuai sisa kuota harian Resend)
//   refresh : cari ulang pencarian tersimpan yang dicentang (hanya tempat baru yang masuk), dengan batas kuota SerpApi.
//             Pencarian yang beberapa kali berturut-turut tidak menghasilkan tempat baru dinonaktifkan sendiri (refresh.dryMax)
//   rotate  : putaran kota: mencari kota BARU dari daftar (rotate.cities) satu per satu, supaya kuota tidak habis untuk mengulang yang sama
//   enrich  : cari email/WhatsApp dari website tempat yang belum dicek
//   queue   : isi antrean persetujuan dengan prospek yang skornya cukup (skor berbasis aturan, _score.js)
// Semua data di Redis berawalan "hairleads:". Tidak memakai AI.
const { dbConfigured, cmd, hgetall, getKey, getActive } = require("./_store");
const { pickSerp, sanitizeSerp, DEFAULT: SERP_DEFAULT } = require("./_serp");
const { sanitizeLead } = require("./_leads");
const { findContacts, tidyEmail } = require("./_contacts");
const { scoreLead, normWeights, DEFAULT_W, FREE } = require("./_score");
const { TEMPLATE, BRAND } = require("./_template");
const M = require("./_mail");
const places = require("./places");
const { pruneData } = require("./_clean");

const LEADS = "hairleads:leads", CACHE = "hairleads:cache", META = "hairleads:cmeta";
const VARC = "hairleads:varc"; // penghitung rotasi variasi per tahap
const AUTO = "hairleads:auto", QUEUE = "hairleads:queue", SEQ = "hairleads:seq", LOCK = "hairleads:autolock";
const DAY = 864e5;
const QUEUE_ROOM = 50; // paling banyak segini prospek menunggu persetujuan sekaligus
const parse = M.parse;

// ---- Pengaturan -----------------------------------------------------------------------------------------
const FU1 = "Hi!\n\nJust following up on my earlier message. We supply wholesale human hair extensions (weft, bulk, tape, nano ring, I/U/K/V tip and more) directly from Indonesia.\n\n" +
  "If it helps, we can send you our product list and wholesale prices. Just reply to this email or message us on WhatsApp: " + BRAND.phone + ".\n\nThank you!";
const FU2 = "Hi!\n\nThis is our last note. If you are ever looking for a reliable hair extension supplier, you are welcome to contact us anytime, by replying to this email or on WhatsApp: " +
  BRAND.phone + ".\n\nWebsite: " + BRAND.website + "\n\nHave a great week!";

const FU1B = "Hi!\n\nQuick follow-up in case my last email got buried. We are a direct supplier of human hair extensions from Indonesia (weft, bulk, tape, nano ring, I/U/K/V tip and more), with wholesale pricing for salons and resellers.\n\n" +
  "Happy to send our catalog and price list. Just reply here or message us on WhatsApp: " + BRAND.phone + ".\n\nBest regards!";
const FU2B = "Hi!\n\nI will not keep filling your inbox. If you ever need a dependable wholesale supplier for hair extensions, reply to this email or reach us on WhatsApp: " +
  BRAND.phone + ".\n\nWebsite: " + BRAND.website + "\n\nWishing you a great week!";

function defaultCfg() {
  return {
    autosearch: true, // saklar utama cari tempat otomatis (cari ulang + putaran kota); nonaktif = cari manual saja
    enrich: { on: true, max: 60 },
    refresh: { on: false, everyDays: 7, maxSearches: 3, reserve: 30, pages: 3, dryMax: 3, keys: [] }, // dryMax: nonaktifkan pencarian yang sekian kali berturut-turut tanpa tempat baru (0 = jangan)
    rotate: { on: false, maxSearches: 2, reserve: 30, pages: 1, kinds: ["salon"], cities: DEFAULT_CITIES.slice() }, // putaran kota baru
    serp: { ...SERP_DEFAULT }, // pindah akun SerpApi otomatis jika sisa kuota akun aktif di bawah "below"
    mail: {
      on: false, approve: true, minScore: 40, perDay: 20, followOn: true, maxBounce: 4,
      weights: { ...DEFAULT_W }, // bobot skor prospek (positif dan negatif), lihat _score.js
      steps: [
        { days: 0, subject: "Human hair extension supplier from Indonesia", text: TEMPLATE },
        { days: 4, subject: "Following up: human hair extension supplier", text: FU1, alts: [{ subject: "Quick follow-up: hair extension supplier", text: FU1B }] },
        { days: 10, subject: "Last note: hair extension supplier from Indonesia", text: FU2, alts: [{ subject: "Closing the loop: hair extensions from Indonesia", text: FU2B }] }
      ]
    },
    notify: { digest: true, alerts: true, to: "" }, // laporan harian dan peringatan lewat email; to kosong = pakai Reply-To
    clean: { on: true, days: 30 }                   // pembersihan data lama
  };
}
const DEFAULT_CITIES = ["New York, United States", "Los Angeles, United States", "Houston, United States", "Atlanta, United States", "Chicago, United States", "Dallas, United States", "Miami, United States", "Detroit, United States", "Philadelphia, United States", "Charlotte, United States", "Baltimore, United States", "Orlando, United States", "London, United Kingdom", "Birmingham, United Kingdom", "Manchester, United Kingdom", "Leeds, United Kingdom", "Glasgow, United Kingdom", "Liverpool, United Kingdom", "Toronto, Canada", "Montreal, Canada", "Lagos, Nigeria", "Abuja, Nigeria", "Port Harcourt, Nigeria", "Johannesburg, South Africa", "Cape Town, South Africa", "Durban, South Africa", "Accra, Ghana", "Nairobi, Kenya"];
const KINDS = ["salon", "wig", "beauty"];
const num = (v, a, b, d) => { v = Math.round(Number(v)); return isFinite(v) ? Math.max(a, Math.min(b, v)) : d; };
const bool = (v, d) => (typeof v === "boolean" ? v : d);

function sanitizeCfg(c) {
  const d = defaultCfg();
  c = c && typeof c === "object" ? c : {};
  const e = c.enrich || {}, r = c.refresh || {}, m = c.mail || {};
  const out = {
    autosearch: bool(c.autosearch, true),
    enrich: { on: bool(e.on, d.enrich.on), max: num(e.max, 1, 200, d.enrich.max) },
    refresh: {
      on: bool(r.on, false), everyDays: num(r.everyDays, 1, 60, 7), maxSearches: num(r.maxSearches, 1, 30, 3), reserve: num(r.reserve, 0, 1000, 30), pages: num(r.pages, 1, 3, 3), dryMax: num(r.dryMax, 0, 10, 3),
      keys: Array.isArray(r.keys) ? [...new Set(r.keys.map(k => String(k).slice(0, 300)).filter(Boolean))].slice(0, 40) : []
    },
    mail: { on: bool(m.on, false), approve: bool(m.approve, true), minScore: num(m.minScore, 0, 100, 40), perDay: num(m.perDay, 1, 100, 20), followOn: bool(m.followOn, true),
      maxBounce: num(m.maxBounce, 1, 20, 4), weights: normWeights(m.weights),
      steps: [] }
  };
  const nt = c.notify || {}, cl = c.clean || {}, nto = M.clean(nt.to, 120).toLowerCase();
  out.serp = sanitizeSerp(c.serp);
  const ro = c.rotate && typeof c.rotate === "object" ? c.rotate : {}, dr = d.rotate;
  const rawCities = Array.isArray(ro.cities) ? ro.cities : (typeof ro.cities === "string" ? ro.cities.split(/\r?\n/) : (c.rotate ? [] : dr.cities));
  const seenC = new Set(), cities = [];
  for (const x of rawCities) { const t = String(x || "").replace(/\s+/g, " ").trim().slice(0, 80), k = t.toLowerCase(); if (t.length >= 2 && !seenC.has(k)) { seenC.add(k); cities.push(t); } if (cities.length >= 200) break; }
  const kinds = Array.isArray(ro.kinds) ? [...new Set(ro.kinds.filter(k => KINDS.includes(k)))] : dr.kinds;
  out.rotate = { on: bool(ro.on, false), maxSearches: num(ro.maxSearches, 1, 10, dr.maxSearches), reserve: num(ro.reserve, 0, 1000, dr.reserve), pages: num(ro.pages, 1, 3, dr.pages),
    kinds: kinds.length ? kinds : dr.kinds, cities };
  out.notify = { digest: bool(nt.digest, true), alerts: bool(nt.alerts, true), to: M.EMAIL.test(nto) ? nto : "" };
  out.clean = { on: bool(cl.on, true), days: num(cl.days, 7, 365, 30) };
  const raw = Array.isArray(m.steps) ? m.steps.slice(0, 4) : d.mail.steps;
  let prev = 0;
  // Variasi tambahan per tahap (maks 2), diputar bergantian per penerima. Yang kosong dibuang.
  const altsOf = s => (Array.isArray(s.alts) ? s.alts : []).slice(0, 8).map(a => {
    a = a && typeof a === "object" ? a : {};
    return { subject: M.clean(a.subject, 200), text: typeof a.text === "string" ? a.text.trim().slice(0, 5000) : "" };
  }).filter(a => a.subject && a.text).slice(0, 2);
  raw.forEach((s, i) => {
    s = s && typeof s === "object" ? s : {};
    const subject = M.clean(s.subject, 200), text = typeof s.text === "string" ? s.text.trim().slice(0, 5000) : "";
    if (i === 0) { out.mail.steps.push({ days: 0, subject: subject || d.mail.steps[0].subject, text: text || d.mail.steps[0].text, alts: altsOf(s) }); return; }
    if (!subject || !text) return; // follow-up yang kosong dibuang
    prev = Math.max(prev + 1, num(s.days, 1, 60, 4 * i));
    out.mail.steps.push({ days: prev, subject, text, alts: altsOf(s) });
  });
  if (!out.mail.steps.length) out.mail.steps.push({ days: 0, subject: d.mail.steps[0].subject, text: d.mail.steps[0].text, alts: [] });
  return out;
}
async function getCfg() {
  if (!dbConfigured()) return sanitizeCfg({});
  const raw = await cmd(["HGET", AUTO, "cfg"]);
  return sanitizeCfg(raw ? parse(raw) : {});
}
async function setCfg(c) {
  const cfg = sanitizeCfg(c);
  await cmd(["HSET", AUTO, "cfg", JSON.stringify(cfg)]);
  return cfg;
}
async function getLog() {
  try { const raw = await cmd(["HGET", AUTO, "log"]); return (raw && parse(raw)) || []; } catch (e) { return []; }
}
async function pushLog(entry) {
  const arr = await getLog();
  arr.unshift(entry);
  await cmd(["HSET", AUTO, "log", JSON.stringify(arr.slice(0, 20))]);
}

// ---- Data -------------------------------------------------------------------------------------------------
async function loadData() {
  const keys = (await cmd(["HKEYS", CACHE])) || [];
  const entries = [];
  for (let i = 0; i < keys.length; i += 8) {
    const got = await Promise.all(keys.slice(i, i + 8).map(k => cmd(["HGET", CACHE, k]).catch(() => null)));
    got.forEach((raw, j) => { const v = raw && parse(raw); if (v && Array.isArray(v.results)) entries.push({ key: keys[i + j], results: v.results }); });
  }
  const lraw = await hgetall(LEADS), leads = {};
  Object.keys(lraw).forEach(k => { const v = parse(lraw[k]); if (v) leads[k] = v; });
  // Satu peta id -> data tempat: hasil pencarian tersimpan, ditimpa data tersimpan (email/WA hasil cek, status)
  const map = new Map();
  const refs = new Map(); // id tempat -> jumlah pencarian yang memuatnya (dipakai pembersih data)
  for (const e of entries) for (const r of e.results) if (r && r.id) { refs.set(r.id, (refs.get(r.id) || 0) + 1); if (!map.has(r.id)) map.set(r.id, { ...r }); }
  for (const id of Object.keys(leads)) {
    const l = leads[id] && leads[id].lead;
    if (!l) continue;
    const base = map.get(id) || { id, name: l.name, address: l.address, phone: l.phone, website: l.website, email: l.email, rating: l.rating, reviews: l.reviews, osm: l.osm };
    if (l.emails && l.emails.length) { base.emails = l.emails; base.email = base.email || l.emails[0]; }
    if (l.wa) base.wa = l.wa;
    if (l.looked) { base.looked = true; base.found = !!l.found; }
    if (l.retry) { base.retry = l.retry; base.rt = l.rt || 0; }
    map.set(id, base);
  }
  return { map, leads, refs, entries };
}
const firstEmail = x => {
  const e = (x.emails && x.emails.length ? x.emails[0] : x.email) || "";
  const t = String(e).trim().toLowerCase();
  return M.EMAIL.test(t) ? t : "";
};
// Alamat Gmail, Yahoo, dll pertama milik tempat itu (sama dengan filter "Hanya email Gmail, Yahoo, dll" di tab Email). Domain sendiri tidak dipakai.
const freeEmail = x => {
  const l = x.emails && x.emails.length ? x.emails : [x.email];
  for (const e of l) { const t = tidyEmail(e); if (M.EMAIL.test(t) && FREE.test(t)) return t; }
  return "";
};
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
function shortDate() { // "3 Nov" dalam WIB, sama dengan catatan otomatis di halaman
  const d = new Date(Date.now() + 7 * 36e5);
  return d.getUTCDate() + " " + BULAN[d.getUTCMonth()];
}

// ---- Enrich -----------------------------------------------------------------------------------------------
// "Tanpa kontak": tidak ada nomor WhatsApp/telepon, dan tidak ada email yang valid (format benar dan domainnya punya MX).
// MX yang belum bisa dipastikan (undefined) tidak dianggap gagal, jadi dicoba lagi di jalan berikutnya.
async function noContact(l, deadline) {
  if (l.wa || String(l.phone || "").replace(/\D/g, "").length >= 8) return false;
  const mails = [...(l.emails || []), l.email].map(tidyEmail).filter(e => M.EMAIL.test(e));
  if (!mails.length) return true;
  const mx = await M.mxCheck(mails.map(M.domainOf), deadline);
  return mails.every(e => mx.get(M.domainOf(e)) === false);
}
async function jobEnrich(cfg, ctx) {
  if (!cfg.enrich.on) return { skip: "nonaktif" };
  // Yang gagal dijangkau dicoba ulang SEKALI, paling cepat 20 jam kemudian (retry=1). Setelah itu ditandai sudah dicek.
  const t0 = Date.now(), RETRY_AFTER = 20 * 36e5;
  const pool = [...ctx.data.map.values()].filter(x => x.id && x.website && !x.looked);
  const all = pool.filter(x => !(x.retry >= 1 && t0 - (x.rt || 0) < RETRY_AFTER));
  const waiting = pool.length - all.length;
  all.sort((a, b) => (a.retry || 0) - (b.retry || 0)); // yang belum pernah dicek didahulukan
  const todo = all.slice(0, cfg.enrich.max);
  let idx = 0, done = 0, found = 0, failed = 0, empty = 0;
  async function worker() {
    while (idx < todo.length && Date.now() < ctx.softEnd) {
      const x = todo[idx++];
      let j = { emails: [], whatsapp: [], failed: false };
      try { j = await findContacts(x.website, ctx.hardEnd); } catch (e) { /* alamat tidak valid: tandai sudah dicek supaya tidak diulang */ }
      const rec0 = ctx.data.leads[x.id] || { s: "", n: "" };
      const prevL = rec0.lead || {};
      const emails = j.emails.length ? j.emails : (prevL.emails || []);
      const wa = j.whatsapp[0] || prevL.wa || x.wa || "";
      const hit = !!(j.emails.length || j.whatsapp.length);
      const tries = x.retry || 0;
      const retryLater = j.failed && !hit && tries < 1; // gagal dijangkau, belum pernah diulang
      const lead = sanitizeLead({ ...x, ...prevL, id: x.id, emails, email: emails[0] || x.email || "", wa,
        looked: !retryLater, found: hit, retry: j.failed && !hit ? tries + 1 : 0, rt: j.failed && !hit ? Date.now() : 0 });
      let st = rec0.s || "";
      if (!st && lead.looked && await noContact(lead, ctx.hardEnd)) { st = "kosong"; empty++; } // otomatis: tidak ada kontak sama sekali
      const rec = { s: st, n: rec0.n || "", t: Date.now(), lead };
      await cmd(["HSET", LEADS, x.id, JSON.stringify(rec)]);
      ctx.data.leads[x.id] = rec;
      x.looked = lead.looked; x.found = lead.found; x.retry = lead.retry; x.rt = lead.rt; x.emails = lead.emails; x.email = lead.email; x.wa = lead.wa;
      done++; if (lead.found) found++; if (retryLater) failed++;
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  if (found) await M.stat("found", found);
  // Tempat yang tidak perlu dicek website (tidak punya website, atau sudah pernah dicek) dan tidak punya kontak sama sekali ikut ditandai,
  // termasuk data lama. Yang sudah punya status tidak disentuh. Maksimal 200 per jalan.
  let swept = 0;
  for (const x of ctx.data.map.values()) {
    if (swept >= 200 || Date.now() > ctx.softEnd) break; // swept = yang benar-benar ditandai, bukan yang sekadar diperiksa
    if (!x.id || (x.website && !x.looked)) continue;
    const rec0 = ctx.data.leads[x.id] || { s: "", n: "" };
    if (rec0.s) continue;
    if (!(await noContact(x, ctx.hardEnd))) continue;
    swept++;
    const rec = { s: "kosong", n: rec0.n || "", t: Date.now(), lead: sanitizeLead({ ...x, ...(rec0.lead || {}), id: x.id, looked: !!(x.looked || (rec0.lead && rec0.lead.looked)) }) };
    await cmd(["HSET", LEADS, x.id, JSON.stringify(rec)]);
    ctx.data.leads[x.id] = rec;
    empty++;
  }
  const out = { done, found, left: Math.max(all.length - done, 0) };
  if (empty) out.empty = empty;
  if (failed) out.retry = failed;
  if (waiting) out.waiting = waiting;
  return out;
}

// ---- Refresh ----------------------------------------------------------------------------------------------
async function jobRefresh(cfg, ctx) {
  const rc = cfg.refresh;
  if (cfg.autosearch === false) return { skip: "cari tempat otomatis dimatikan" };
  if (!rc.on && !ctx.force) return { skip: "nonaktif" };
  if (!rc.keys.length) return { skip: "belum ada pencarian yang dicentang" };
  const meta = await hgetall(META), now = Date.now(), due = [];
  for (const key of rc.keys) {
    const m = parse(meta[key] || "null");
    if (!m || !m.city) continue;
    const rf = Number(await cmd(["HGET", AUTO, "rf:" + key])) || 0;
    const last = Math.max(rf, m.at || 0);
    if (ctx.force || now - last >= rc.everyDays * DAY - 6 * 36e5) due.push({ key, m, last });
  }
  if (!due.length) return { searches: 0, added: 0, note: "belum waktunya" };
  due.sort((a, b) => a.last - b.last);
  // Sisa kuota per akun SerpApi: dibaca segar sebelum tiap pencarian (pindah akun otomatis terjadi di sini dan di searchCore),
  // lalu dikurangi hitungan lokal supaya tidak terkecoh data SerpApi yang telat update.
  const tracked = {};
  const leftNow = async () => {
    const sp = await pickSerp();
    if (!sp) return { n: 0, left: null, sw: null };
    if (sp.left !== null) tracked[sp.n] = Math.min(tracked[sp.n] === undefined ? Infinity : tracked[sp.n], sp.left);
    return { n: sp.n, left: sp.left === null ? null : tracked[sp.n], sw: sp.switched };
  };
  let searches = 0, added = 0, extra = 0, err = "", skipped = 0, stop = false;
  const switches = [];
  // Pencarian kering: berapa kali berturut-turut tidak menghasilkan tempat baru. Dihitung paling banyak sekali per ~20 jam,
  // jadi menekan "Jalankan sekarang" berkali-kali tidak mematikan pencarian secara keliru.
  const dryRaw = await cmd(["HGET", AUTO, "dry"]).catch(() => null), dry = (dryRaw && parse(dryRaw)) || {};
  const off = [], offLabel = [];
  const noteSw = sw => { if (sw) switches.push(sw); };
  for (const d of due) {
    if (stop || searches >= rc.maxSearches) break;
    // Halaman 2-3 hanya diambil jika seluruh isi halaman sebelumnya baru. Tiap halaman memakai 1 kuota dan dihitung ke "Maks pencarian".
    const pages = d.m.source === "osm" ? 1 : rc.pages;
    let keyAdded = 0, p0ok = false;
    for (let p = 0; p < pages; p++) {
      if (searches >= rc.maxSearches) break;
      if (ctx.softEnd - Date.now() < 30000) { stop = true; break; } // satu pencarian bisa sampai 25 detik
      if (d.m.source !== "osm") {
        const lf = await leftNow();
        noteSw(lf.sw);
        if (lf.left !== null && lf.left - 1 < rc.reserve) { skipped++; break; } // sisakan kuota SerpApi
      }
      let r;
      try {
        r = await places.searchCore({ city: d.m.city, kind: d.m.kind, source: d.m.source, refresh: true, start: p * 20 }, { merge: true });
      } catch (e) { err = e.message; if (/SerpApi|kuota|key/i.test(e.message)) stop = true; break; }
      noteSw(r.switched);
      if (p === 0) await cmd(["HSET", AUTO, "rf:" + d.key, String(Date.now())]);
      searches++; added += r.added || 0; keyAdded += r.added || 0; if (p > 0) extra++;
      if (p === 0) p0ok = true;
      if (r.acct && tracked[r.acct] !== undefined) tracked[r.acct]--;
      // Lanjut ke halaman berikutnya hanya jika halaman ini penuh tempat baru dan Google Maps masih punya halaman lagi
      if (!(r.pageN > 0 && r.added >= r.pageN && r.pageMore)) break;
    }
    // Halaman pertama berhasil dicari: hitung sebagai "kering" jika seluruh pencarian ini tidak menambah tempat baru
    if (p0ok && rc.dryMax > 0) {
      const prev = dry[d.key] || { n: 0, t: 0 };
      if (keyAdded > 0) delete dry[d.key];
      else if (Date.now() - prev.t >= 20 * 36e5) {
        const n = prev.n + 1;
        if (n >= rc.dryMax) { off.push(d.key); offLabel.push(d.m.city + " · " + d.m.kind); delete dry[d.key]; }
        else dry[d.key] = { n, t: Date.now() };
      }
    }
  }
  if (added) await M.stat("added", added);
  // Simpan hitungan (buang yang pencariannya sudah tidak dicentang), lalu matikan centang pencarian yang kering
  try {
    Object.keys(dry).forEach(k => { if (!rc.keys.includes(k) || off.includes(k)) delete dry[k]; });
    await cmd(["HSET", AUTO, "dry", JSON.stringify(dry)]);
    if (off.length) {
      const fresh = await getCfg(); // baca ulang supaya perubahan pengaturan yang baru disimpan tidak tertimpa
      fresh.refresh.keys = fresh.refresh.keys.filter(k => !off.includes(k));
      await setCfg(fresh);
      rc.keys = rc.keys.filter(k => !off.includes(k));
    }
  } catch (e) { /* gagal menyimpan hitungan tidak boleh menggagalkan pencarian */ }
  const out = { searches, added };
  if (offLabel.length) out.disabled = offLabel;
  if (extra) out.pages = extra;
  if (skipped) out.note = "dilewati " + skipped + " (sisa kuota SerpApi di bawah batas aman)";
  if (switches.length) { const w = switches[switches.length - 1]; out.switched = "Akun " + w.from + " -> Akun " + w.to + (w.why === "error" ? " (kuota habis)" : " (sisa " + w.left + ", di bawah batas)"); }
  if (err) out.err = err;
  return out;
}

// ---- Putaran kota ------------------------------------------------------------------------------------------
// Mencari kota BARU dari daftar cfg.rotate.cities (tiap kota x tiap jenis) satu per satu. Kombinasi yang sudah pernah dicari
// (ada di daftar pencarian tersimpan, atau sudah pernah dicoba putaran ini) dilewati, jadi tiap jalan selalu maju ke kota berikutnya.
async function getRot() {
  try { const raw = await cmd(["HGET", AUTO, "rot"]); return (raw && parse(raw)) || {}; } catch (e) { return {}; }
}
async function rotInfo(cfg) {
  const rc = cfg.rotate, done = await getRot(), meta = await hgetall(META), todo = [];
  for (const city of rc.cities) for (const kind of rc.kinds) {
    const ck = places.cacheKey(city, kind, "google");
    if (!meta[ck] && !done[ck]) todo.push({ city, kind, ck });
  }
  return { total: rc.cities.length * rc.kinds.length, left: todo.length, todo };
}
// Kota berikutnya yang belum pernah dicari (untuk jenis dan sumber yang dipilih) dari daftar putaran kota. Dipakai tombol di Cari tempat (manual).
async function nextCity(cfg, kind, source) {
  const rc = cfg.rotate, done = await getRot(), meta = await hgetall(META), todo = [];
  for (const city of rc.cities) {
    const ck = places.cacheKey(city, kind, source);
    if (!meta[ck] && !(source === "google" && done[ck])) todo.push(city);
  }
  return { total: rc.cities.length, left: todo.length, city: todo[0] || null, next: todo.slice(1, 3) };
}
async function jobRotate(cfg, ctx) {
  const rc = cfg.rotate;
  if (cfg.autosearch === false) return { skip: "cari tempat otomatis dimatikan" };
  if (!rc.on) return { skip: "nonaktif" };
  if (!rc.cities.length) return { skip: "daftar kota kosong" };
  const day = M.today();
  let usedRaw = null; try { usedRaw = await cmd(["HGET", AUTO, "rotday"]); } catch (e) { /* anggap 0 */ }
  const ud = usedRaw && parse(usedRaw);
  let usedToday = ud && ud.d === day ? Number(ud.n) || 0 : 0;
  const room = rc.maxSearches - usedToday;
  if (room <= 0) return { skip: "batas " + rc.maxSearches + " pencarian hari ini tercapai" };
  const info = await rotInfo(cfg);
  if (!info.todo.length) return { searches: 0, added: 0, left: 0, note: "semua kota di daftar sudah pernah dicari. Tambah kota baru di Pengaturan" };

  const rot = await getRot(), switches = [], cities = [];
  let searches = 0, added = 0, err = "", skipped = false, stop = false, doneCities = 0;
  for (const t of info.todo) {
    if (stop || searches >= room) break;
    if (ctx.softEnd - Date.now() < 30000) break; // satu pencarian bisa sampai 25 detik
    const sp = await pickSerp();
    if (!sp) { err = "API key SerpApi belum diisi"; break; }
    if (sp.switched) switches.push(sp.switched);
    let left = sp.left;
    let cityAdded = 0, ok = false, hardErr = false;
    for (let p = 0; p < rc.pages; p++) {
      if (searches >= room) break;
      if (left !== null && left - 1 < rc.reserve) { if (p === 0) skipped = true; stop = p === 0 || stop; break; } // sisakan kuota SerpApi
      if (p > 0 && ctx.softEnd - Date.now() < 30000) break;
      let r;
      try {
        r = await places.searchCore({ city: t.city, kind: t.kind, source: "google", refresh: true, start: p * 20 }, { merge: true });
      } catch (e) {
        err = e.message;
        if (/SerpApi|kuota|quota|key/i.test(e.message)) stop = true; else hardErr = true; // gagal karena kuota: coba lagi nanti; gagal lain: tandai sudah dicoba
        break;
      }
      if (r.switched) switches.push(r.switched);
      searches++; usedToday++; added += r.added || 0; cityAdded += r.added || 0;
      if (left !== null) left--;
      if (p === 0) ok = true;
      if (!(r.pageN > 0 && r.added >= r.pageN && r.pageMore)) break; // halaman berikutnya hanya jika halaman ini penuh tempat baru
    }
    if (ok || hardErr) { // kombinasi ini dianggap sudah dicoba, jadi putaran maju ke kota berikutnya (walau hasilnya kosong)
      rot[t.ck] = { t: Date.now(), a: cityAdded, e: hardErr ? 1 : 0 };
      doneCities++;
      cities.push(t.city + " · " + t.kind + " (+" + cityAdded + ")");
    }
  }
  try {
    const keys = Object.keys(rot);
    if (keys.length > 1500) keys.sort((a, b) => (rot[a].t || 0) - (rot[b].t || 0)).slice(0, keys.length - 1500).forEach(k => delete rot[k]);
    await cmd(["HSET", AUTO, "rot", JSON.stringify(rot)]);
    await cmd(["HSET", AUTO, "rotday", JSON.stringify({ d: day, n: usedToday })]);
  } catch (e) { /* gagal menyimpan: kota yang sama bisa dicari lagi di jalan berikutnya, tapi hasilnya sudah tersimpan di cache */ }
  if (added) await M.stat("added", added);
  const out = { searches, added, left: Math.max(info.left - doneCities, 0) };
  if (cities.length) out.cities = cities;
  if (skipped) out.note = "dilewati (sisa kuota SerpApi di bawah batas aman)";
  if (switches.length) { const w = switches[switches.length - 1]; out.switched = "Akun " + w.from + " -> Akun " + w.to + (w.why === "error" ? " (kuota habis)" : " (sisa " + w.left + ", di bawah batas)"); }
  if (err) out.err = err;
  return out;
}

// ---- Mail: antrean ----------------------------------------------------------------------------------------
async function jobQueue(cfg, ctx) {
  if (!cfg.mail.on && !ctx.force) return { skip: "nonaktif" };
  const qraw = await hgetall(QUEUE), queue = {};
  Object.keys(qraw).forEach(k => { const v = parse(qraw[k]); if (v) queue[k] = v; });
  const mraw = await hgetall(M.MAIL), mailed = new Set(Object.keys(mraw)), mailedTo = new Set();
  Object.keys(mraw).forEach(k => { const v = parse(mraw[k]); if (v && v.to) mailedTo.add(String(v.to).toLowerCase()); });
  Object.keys(queue).forEach(k => mailedTo.add(String(queue[k].to || "").toLowerCase()));
  const pending = Object.keys(queue).filter(k => queue[k].st === "pending").length;
  const room = Math.max(QUEUE_ROOM - pending, 0);

  // Satu bisnis cukup satu email: domain email milik sendiri (bukan Gmail dkk) dan host website yang sudah pernah dikirimi / diantrekan dilewati
  const SOCIAL = /(^|\.)(facebook|instagram|linktr|linktree|tiktok|youtube|twitter|x|wa|whatsapp|yelp|google|business\.site|wixsite|squarespace|godaddysites|shopify|etsy|ebay|amazon)\.[a-z.]+$/i;
  const siteHost = w => { try { const h = new URL(/^https?:\/\//i.test(w) ? w : "https://" + w).hostname.replace(/^www\./, "").toLowerCase(); return SOCIAL.test(h) ? "" : h; } catch (e) { return ""; } };
  const ownDom = e => { const d = M.domainOf(e); return d && !FREE.test("@" + d) ? d : ""; };
  const usedDom = new Set();
  const addUsed = (to, id) => { const d = ownDom(to); if (d) usedDom.add("d:" + d); const x = id && ctx.data.map.get(id), h = x && x.website ? siteHost(x.website) : ""; if (h) usedDom.add("s:" + h); };
  Object.keys(mraw).forEach(k => { const v = parse(mraw[k]); if (v) addUsed(v.to, k); });
  Object.keys(queue).forEach(k => addUsed(queue[k].to, k));

  const cand = [], seenTo = new Set(), seenDom = new Set();
  let dupDomain = 0;
  for (const x of ctx.data.map.values()) {
    if (!x.id || queue[x.id] || mailed.has(x.id)) continue;
    const rec = ctx.data.leads[x.id];
    if (rec && rec.s) continue; // hanya yang belum dihubungi
    const to = freeEmail(x);
    if (!to || mailedTo.has(to) || seenTo.has(to)) continue;
    const sc = scoreLead(x, cfg.mail.weights);
    if (sc.s < cfg.mail.minScore) continue;
    cand.push({ x, to, sc, dk: [ownDom(to) && "d:" + ownDom(to), x.website && siteHost(x.website) && "s:" + siteHost(x.website)].filter(Boolean) });
  }
  const sup = await M.suppressedSet(cand.map(c => c.to));
  let pool = cand.filter(c => !sup.has(c.to)).sort((a, b) => b.sc.s - a.sc.s);
  // Domain email harus bisa menerima email (MX). Yang belum bisa dipastikan ditunda ke jalan berikutnya, bukan ditolak.
  const mx = await M.mxCheck(pool.map(c => M.domainOf(c.to)), ctx.softEnd);
  let badMx = 0, pendingMx = 0;
  pool = pool.filter(c => { const r = mx.get(M.domainOf(c.to)); if (r === false) { badMx++; return false; } if (r === undefined) { pendingMx++; return false; } return true; });
  const ok = [];
  for (const c of pool) {
    if (c.dk.some(k => usedDom.has(k) || seenDom.has(k))) { dupDomain++; continue; }
    c.dk.forEach(k => seenDom.add(k));
    seenTo.add(c.to);
    ok.push(c);
  }
  // Mode kirim otomatis penuh (approve:false) tidak memakai batas ruang antrean, karena langsung "ok"
  const take = cfg.mail.approve ? ok.slice(0, room) : ok.slice(0, 200);
  const args = [], now = Date.now();
  for (const c of take) {
    args.push(c.x.id, JSON.stringify({ id: c.x.id, to: c.to, name: M.clean(c.x.name, 80), sc: c.sc.s, why: c.sc.neg.concat(c.sc.why).slice(0, 4), st: cfg.mail.approve ? "pending" : "ok", t: now }));
  }
  for (let i = 0; i < args.length; i += 200) await cmd(["HSET", QUEUE, ...args.slice(i, i + 200)]);
  if (take.length) await M.stat("queued", take.length);
  const res = { added: take.length, pending: pending + (cfg.mail.approve ? take.length : 0), waiting: Math.max(ok.length - take.length, 0) };
  if (badMx) res.noMx = badMx;
  if (dupDomain) res.dupDomain = dupDomain;
  if (pendingMx) res.mxLater = pendingMx;
  return res;
}

// Diagnosa: kenapa tempat yang punya email tidak masuk antrean? Memakai syarat yang sama dengan jobQueue, tapi hanya membaca (tidak mengubah data).
// Hasil: { id: "alasan singkat" } untuk tempat Gmail/Yahoo dkk yang belum ada di antrean.
async function queueWhy(ids) {
  const cfg = await getCfg(), data = await loadData();
  const qraw = await hgetall(QUEUE), queue = {};
  Object.keys(qraw).forEach(k => { const v = parse(qraw[k]); if (v) queue[k] = v; });
  const mraw = await hgetall(M.MAIL), mailed = new Set(Object.keys(mraw)), mailedTo = new Map();
  Object.keys(mraw).forEach(k => { const v = parse(mraw[k]); if (v && v.to) mailedTo.set(String(v.to).toLowerCase(), "sudah pernah dikirimi"); });
  Object.keys(queue).forEach(k => { const t = String(queue[k].to || "").toLowerCase(); if (t && !mailedTo.has(t)) mailedTo.set(t, "sudah ada di antrean (" + (queue[k].name || "tempat lain") + ")"); });
  const pending = Object.keys(queue).filter(k => queue[k].st === "pending").length;
  const room = Math.max(QUEUE_ROOM - pending, 0);

  const SOCIAL = /(^|\.)(facebook|instagram|linktr|linktree|tiktok|youtube|twitter|x|wa|whatsapp|yelp|google|business\.site|wixsite|squarespace|godaddysites|shopify|etsy|ebay|amazon)\.[a-z.]+$/i;
  const siteHost = w => { try { const h = new URL(/^https?:\/\//i.test(w) ? w : "https://" + w).hostname.replace(/^www\./, "").toLowerCase(); return SOCIAL.test(h) ? "" : h; } catch (e) { return ""; } };
  const ownDom = e => { const d = M.domainOf(e); return d && !FREE.test("@" + d) ? d : ""; };
  const used = new Map(); // kunci domain/website -> nama tempat yang sudah memakainya
  const addUsed = (to, id, nm) => {
    const d = ownDom(to); if (d && !used.has("d:" + d)) used.set("d:" + d, nm || d);
    const x = id && data.map.get(id), h = x && x.website ? siteHost(x.website) : "";
    if (h && !used.has("s:" + h)) used.set("s:" + h, nm || h);
  };
  Object.keys(mraw).forEach(k => { const v = parse(mraw[k]); if (v) addUsed(v.to, k, (data.map.get(k) || {}).name || v.to); });
  Object.keys(queue).forEach(k => addUsed(queue[k].to, k, queue[k].name));

  const want = ids && ids.length ? new Set(ids) : null, out = {}, cand = [], seenTo = new Map(), seenDom = new Map();
  const ordered = [...data.map.values()].filter(x => x.id && (!want || want.has(x.id)));
  for (const x of ordered) {
    if (queue[x.id]) continue;
    const rec = data.leads[x.id];
    if (mailed.has(x.id)) { out[x.id] = "sudah pernah dikirimi email"; continue; }
    if (rec && rec.s) { out[x.id] = "status sudah bukan Belum dihubungi"; continue; }
    const to = freeEmail(x);
    if (!to) { const any = (x.emails && x.emails.length ? x.emails : [x.email]).filter(Boolean); out[x.id] = any.length ? "email tidak terbaca valid oleh server (" + any.slice(0, 2).join(", ") + ")" : "server belum punya email tempat ini (cek email belum tersimpan)"; continue; }
    if (mailedTo.has(to)) { out[x.id] = "email " + to + " " + mailedTo.get(to); continue; }
    const sc = scoreLead(x, cfg.mail.weights);
    if (sc.s < cfg.mail.minScore) { out[x.id] = "skor server " + sc.s + " di bawah batas " + cfg.mail.minScore; continue; }
    cand.push({ x, to, sc, dk: [ownDom(to) && "d:" + ownDom(to), x.website && siteHost(x.website) && "s:" + siteHost(x.website)].filter(Boolean) });
  }
  const sup = await M.suppressedSet(cand.map(c => c.to));
  const pool0 = cand.filter(c => { if (sup.has(c.to)) { out[c.x.id] = "ada di Daftar berhenti"; return false; } return true; }).sort((a, b) => b.sc.s - a.sc.s);
  const mx = await M.mxCheck(pool0.map(c => M.domainOf(c.to)), Date.now() + 8000);
  const pool = pool0.filter(c => {
    const r = mx.get(M.domainOf(c.to));
    if (r === false) { out[c.x.id] = "domain email tidak valid (tanpa MX)"; return false; }
    if (r === undefined) { out[c.x.id] = "cek domain email belum selesai, coba lagi"; return false; }
    return true;
  });
  let slot = 0;
  for (const c of pool) {
    const hit = c.dk.find(k => used.has(k) || seenDom.has(k));
    if (hit) { out[c.x.id] = "bisnis sama dengan " + (used.get(hit) || seenDom.get(hit)) + " (" + hit.slice(2) + ")"; continue; }
    c.dk.forEach(k => seenDom.set(k, c.x.name || c.to));
    if (seenTo.has(c.to)) { out[c.x.id] = "email sama dengan " + seenTo.get(c.to); continue; }
    seenTo.set(c.to, c.x.name || c.to);
    if (cfg.mail.approve && slot >= room) out[c.x.id] = "antrean penuh (maks " + QUEUE_ROOM + " menunggu persetujuan)";
    else out[c.x.id] = "lolos syarat, akan masuk saat Jalankan sekarang atau cari berikutnya";
    slot++;
  }
  return out;
}

// Masukkan tempat ke antrean secara manual (dari tombol di tab Email). Dipakai untuk tempat yang belum masuk sendiri
// (cek domain belum selesai, atau pernah ditolak). Tidak mengubah yang sudah ok/pending; yang berstatus "no" dihidupkan lagi.
async function enqueue(ids) {
  const cfg = await getCfg(), data = await loadData();
  const qraw = await hgetall(QUEUE), queue = {};
  Object.keys(qraw).forEach(k => { const v = parse(qraw[k]); if (v) queue[k] = v; });
  const mailed = new Set(Object.keys(await hgetall(M.MAIL)));
  const res = { added: 0, already: 0, skipped: [] }, cand = [];
  for (const id of ids) {
    const x = data.map.get(id), nm = x ? M.clean(x.name, 80) : id;
    if (!x) { res.skipped.push({ id, name: nm, why: "tempat tidak ditemukan" }); continue; }
    const q = queue[id];
    if (q && (q.st === "ok" || q.st === "pending")) { res.already++; continue; }
    if (mailed.has(id)) { res.skipped.push({ id, name: nm, why: "sudah pernah dikirimi" }); continue; }
    const to = freeEmail(x);
    if (!to) { res.skipped.push({ id, name: nm, why: "tidak ada email Gmail/Yahoo dkk yang valid" }); continue; }
    cand.push({ x, to, name: nm });
  }
  const sup = await M.suppressedSet(cand.map(c => c.to));
  const args = [], now = Date.now();
  for (const c of cand) {
    if (sup.has(c.to)) { res.skipped.push({ id: c.x.id, name: c.name, why: "ada di Daftar berhenti" }); continue; }
    const sc = scoreLead(c.x, cfg.mail.weights);
    args.push(c.x.id, JSON.stringify({ id: c.x.id, to: c.to, name: c.name, sc: sc.s, why: sc.neg.concat(sc.why).slice(0, 4), st: cfg.mail.approve ? "pending" : "ok", t: now, man: 1 }));
    res.added++;
  }
  for (let i = 0; i < args.length; i += 200) await cmd(["HSET", QUEUE, ...args.slice(i, i + 200)]);
  if (res.added) await M.stat("queued", res.added);
  res.pending = cfg.mail.approve;
  return res;
}

// Uji bobot: hitung ulang skor prospek yang memenuhi syarat antrean (Belum dihubungi, punya email, belum pernah dikirimi)
// dengan bobot dan batas dari halaman (belum perlu disimpan). Tidak mengubah data apa pun.
async function scorePreview(cfgIn) {
  const cfg = sanitizeCfg({ mail: { ...(cfgIn && cfgIn.mail), steps: undefined } });
  const data = await loadData();
  const mraw = await hgetall(M.MAIL), mailed = new Set(Object.keys(mraw));
  const rows = [];
  for (const x of data.map.values()) {
    if (!x.id || mailed.has(x.id)) continue;
    const rec = data.leads[x.id];
    if (rec && rec.s) continue;
    const to = freeEmail(x);
    if (!to) continue;
    const sc = scoreLead(x, cfg.mail.weights);
    rows.push({ id: x.id, name: M.clean(x.name, 80), to, s: sc.s, why: sc.neg.concat(sc.why).slice(0, 5) });
  }
  rows.sort((a, b) => b.s - a.s);
  const min = cfg.mail.minScore, pass = rows.filter(r => r.s >= min).length;
  const bands = [0, 0, 0, 0, 0]; // 0-19, 20-39, 40-59, 60-79, 80-100
  rows.forEach(r => { bands[Math.min(4, Math.floor(r.s / 20))]++; });
  const withNeg = rows.filter(r => r.why.some(w => /^(jaringan|bukan bisnis|email tidak|rating rendah|hampir tanpa|website hanya)/.test(w))).length;
  // contoh: 5 teratas, 5 di sekitar batas, dan yang kena sinyal negatif
  const near = rows.filter(r => Math.abs(r.s - min) <= 10).slice(0, 5);
  const hit = rows.filter(r => r.why.some(w => /^(jaringan|bukan bisnis|email tidak|rating rendah|hampir tanpa|website hanya)/.test(w))).slice(0, 5);
  return { total: rows.length, pass, min, bands, withNeg, top: rows.slice(0, 5), near, hit };
}

// ---- Mail: kirim ------------------------------------------------------------------------------------------
async function markEmailed(ctx, id, lead) {
  let rec = ctx.data.leads[id];
  if (!rec) rec = { s: "", n: "", lead: sanitizeLead({ ...lead, id }) };
  const line = "Email, " + shortDate();
  const n = String(rec.n || "");
  rec.n = n.indexOf(line) > -1 ? n : (n ? n + "\n" + line : line);
  if (!rec.s) rec.s = "chat"; // Sudah dihubungi
  rec.t = Date.now();
  await cmd(["HSET", LEADS, id, JSON.stringify(rec)]);
  ctx.data.leads[id] = rec;
}

async function jobMailSend(cfg, ctx) {
  if (!cfg.mail.on) return { skip: "nonaktif" };
  const rc = await M.config();
  if (!rc.key || !/@/.test(rc.from)) return { skip: "Resend belum diisi (API key dan email pengirim)" };
  let used = await M.usedToday();
  // perDay adalah batas TOTAL per hari, termasuk email yang sudah terkirim hari ini
  const cap = Math.min(Math.max(cfg.mail.perDay - used, 0), M.DAILY > 0 ? Math.max(M.DAILY - used, 0) : Infinity);
  if (cap <= 0) return { skip: (M.DAILY > 0 && used >= M.DAILY ? "kuota email hari ini habis" : "batas harian tercapai (" + used + " dari " + cfg.mail.perDay + ")") };
  const steps = cfg.mail.steps, now = Date.now();

  const seqRaw = await hgetall(SEQ), qRaw = await hgetall(QUEUE);
  const fu = [];
  if (cfg.mail.followOn) {
    for (const id of Object.keys(seqRaw)) {
      const s = parse(seqRaw[id]);
      if (!s || !s.to || !(s.n >= 1) || s.n >= steps.length) continue;
      if (now < s.first + steps[s.n].days * DAY - 6 * 36e5) continue; // belum waktunya (toleransi 6 jam karena jam cron bisa bergeser)
      const rec = ctx.data.leads[id];
      const st = rec && rec.s || "";
      if (st !== "" && st !== "chat") continue; // sudah dibalas / deal / tidak cocok: urutan berhenti
      fu.push({ id, to: s.to, name: s.name || "", n: s.n, due: s.first + steps[s.n].days * DAY, fu: true });
    }
    fu.sort((a, b) => a.due - b.due);
  }
  const fresh = [];
  const mailed = new Set(Object.keys(await hgetall(M.MAIL)));
  const stale = [];
  for (const id of Object.keys(qRaw)) {
    const q = parse(qRaw[id]);
    if (!q || q.st !== "ok") continue;
    const rec = ctx.data.leads[id];
    if (mailed.has(id) || (rec && rec.s) || !M.EMAIL.test(q.to || "") || !FREE.test(String(q.to).toLowerCase())) { stale.push(id); continue; }
    fresh.push({ id, to: tidyEmail(q.to), name: q.name || "", n: 0, sc: q.sc || 0, fu: false });
  }
  fresh.sort((a, b) => b.sc - a.sc);
  if (stale.length) await cmd(["HDEL", QUEUE, ...stale]);

  const sup = await M.suppressedSet([...fu, ...fresh].map(i => i.to));
  const seenTo = new Set(), list = [];
  for (const i of [...fu, ...fresh]) {
    if (sup.has(i.to) || seenTo.has(i.to)) continue;
    seenTo.add(i.to);
    list.push(i);
    if (list.length >= cap) break;
  }
  if (!list.length) return { sent: 0, followups: 0, note: "tidak ada yang perlu dikirim" };

  // Variasi diputar bergantian per tahap: penghitung disimpan di VARC (s0, s1, ...) dan hanya naik untuk email yang benar-benar terkirim
  const vc = {}, vraw = await hgetall(VARC);
  Object.keys(vraw).forEach(k => { vc[k] = parseInt(vraw[k], 10) || 0; });
  const variant = (n, v) => (v === 0 ? steps[n] : steps[n].alts[v - 1]);
  for (const c of list) {
    const total = 1 + ((steps[c.n].alts || []).length), k = "s" + c.n;
    c.v = (vc[k] || 0) % total;
    vc[k] = (vc[k] || 0) + 1;
  }
  let sent = 0, sentFu = 0, err = "";
  for (let i = 0; i < list.length; i += M.MAX) {
    const chunk = list.slice(i, i + M.MAX);
    try {
      await M.sendBatch(rc, chunk.map(c => { const v = variant(c.n, c.v); return { to: c.to, subject: v.subject, text: M.greet(v.text, c.name) }; }), ctx.base);
    } catch (e) { err = e.message; break; }
    used = await M.recordSent(chunk, used);
    const bump = {};
    chunk.forEach(c => { bump["s" + c.n] = (bump["s" + c.n] || 0) + 1; });
    for (const k of Object.keys(bump)) { try { await cmd(["HINCRBY", VARC, k, bump[k]]); } catch (e) { /* abaikan */ } }
    for (const c of chunk) {
      const t = Date.now();
      try {
        const prev = c.fu ? parse(seqRaw[c.id]) : null;
        const vs = prev && Array.isArray(prev.vs) ? prev.vs.slice() : [];
        vs[c.n] = c.v;
        await cmd(["HSET", SEQ, c.id, JSON.stringify({ to: c.to, name: c.name, n: c.n + 1, first: prev ? prev.first : t, last: t, vs })]);
        if (!c.fu) await cmd(["HDEL", QUEUE, c.id]);
        await markEmailed(ctx, c.id, ctx.data.map.get(c.id) || { name: c.name });
      } catch (e) { /* gagal mencatat tidak boleh menghentikan sisanya; email sudah terkirim */ }
      if (c.fu) sentFu++; else sent++;
    }
  }
  const out = { sent, followups: sentFu, cap: Number.isFinite(cap) ? cap : null };
  if (err) out.err = err;
  return out;
}

// ---- Laporan harian dan peringatan ------------------------------------------------------------------------
async function serpAccounts() {
  try {
    const [k1, k2] = await Promise.all([getKey("serp"), getKey("serp2")]);
    const list = [[1, k1 || process.env.SERPAPI_KEY], [2, k2]].filter(x => x[1]);
    const got = await Promise.all(list.map(async ([n, key]) => {
      try {
        const r = await fetch("https://serpapi.com/account.json?api_key=" + encodeURIComponent(key), { headers: { "User-Agent": "hair-leads-demo/1.0" }, signal: AbortSignal.timeout(8000) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error || j.searches_per_month == null) return null;
        const limit = Number(j.searches_per_month) || 0, used = Number(j.this_month_usage) || 0;
        return { n, limit, used, left: j.total_searches_left != null ? Number(j.total_searches_left) : Math.max(limit - used, 0) };
      } catch (e) { return null; }
    }));
    return got.filter(Boolean);
  } catch (e) { return []; }
}
const escH = x => String(x == null ? "" : x).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Email HTML berbasis tabel (aman untuk Gmail/Outlook: semua gaya inline, tanpa CSS eksternal).
// d = { brand, date, rows:[[label, hariIni, kemarin]], status:[[label, nilai, "ok"|"warn"|"bad"|""]], quota:[{label, text, pct, tone}], base }
function renderDigestHtml(d) {
  const G = "#0f6b57", TONE = { ok: ["#e6f4ef", "#0f6b57"], warn: ["#fff4d6", "#8a5a00"], bad: ["#fde8e8", "#b42318"], "": ["#f1f3f5", "#475467"] };
  const bar = (pct, tone) => {
    const w = Math.max(0, Math.min(100, Math.round(pct))), c = tone === "bad" ? "#d92d20" : tone === "warn" ? "#f59e0b" : G;
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e5e7eb;border-radius:4px"><tr>' +
      (w > 0 ? '<td width="' + w + '%" style="background:' + c + ';height:8px;font-size:0;line-height:0;border-radius:4px">&nbsp;</td>' : "") +
      '<td style="height:8px;font-size:0;line-height:0">&nbsp;</td></tr></table>';
  };
  const th = (t, a) => '<th align="' + a + '" style="padding:10px 12px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#667085;background:#f8fafb;border-bottom:1px solid #e4e7ec;font-weight:600">' + t + "</th>";
  const metric = d.rows.map((r, i) => {
    const z = r[1] === 0 || r[1] == null;
    return '<tr><td style="padding:10px 12px;font-size:14px;color:#344054;border-bottom:1px solid #eef0f3' + (i === d.rows.length - 1 ? ";border-bottom:0" : "") + '">' + escH(r[0]) + "</td>" +
      '<td align="right" style="padding:10px 12px;font-size:15px;font-weight:700;color:' + (z ? "#98a2b3" : "#101828") + ';border-bottom:1px solid #eef0f3' + (i === d.rows.length - 1 ? ";border-bottom:0" : "") + '">' + escH(r[1] == null ? 0 : r[1]) + "</td>" +
      '<td align="right" style="padding:10px 12px;font-size:14px;color:#98a2b3;border-bottom:1px solid #eef0f3' + (i === d.rows.length - 1 ? ";border-bottom:0" : "") + '">' + escH(r[2] == null ? 0 : r[2]) + "</td></tr>";
  }).join("");
  const status = d.status.map(r => {
    const t = TONE[r[2] || ""];
    return '<tr><td style="padding:8px 0;font-size:14px;color:#344054">' + escH(r[0]) + '</td><td align="right" style="padding:8px 0"><span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:' + t[0] + ";color:" + t[1] + '">' + escH(r[1]) + "</span></td></tr>";
  }).join("");
  const quota = d.quota.map(q =>
    '<tr><td style="padding:8px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:14px;color:#344054;padding-bottom:6px">' + escH(q.label) + '</td><td align="right" style="font-size:13px;color:#667085;padding-bottom:6px">' + escH(q.text) + "</td></tr>" +
    (q.pct == null ? "" : '<tr><td colspan="2">' + bar(q.pct, q.tone) + "</td></tr>") + "</table></td></tr>").join("");
  const sec = t => '<tr><td style="padding:22px 24px 6px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#667085;font-weight:700">' + t + "</td></tr>";
  return '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f2f4f7">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f7"><tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e4e7ec;border-radius:12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">' +
    '<tr><td style="background:' + G + ';padding:22px 24px;border-radius:12px 12px 0 0"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#bfe3d8">Ringkasan harian</div>' +
    '<div style="font-size:22px;font-weight:700;color:#ffffff;margin-top:4px">' + escH(d.brand) + '</div><div style="font-size:13px;color:#d6efe7;margin-top:2px">' + escH(d.date) + "</div></td></tr>" +
    sec("Aktivitas") +
    '<tr><td style="padding:6px 24px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e7ec;border-radius:8px;border-collapse:separate;overflow:hidden"><tr>' + th("Metrik", "left") + th("Hari ini", "right") + th("Kemarin", "right") + "</tr>" + metric + "</table>" +
    '<div style="font-size:12px;color:#98a2b3;padding-top:8px">Hari ini = sejak pukul 07.00 WIB (awal hari UTC), termasuk jalan otomatis ini.</div></td></tr>' +
    sec("Status") + '<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + status + "</table></td></tr>" +
    sec("Kuota") + '<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + quota + "</table></td></tr>" +
    (d.base ? '<tr><td align="center" style="padding:24px"><a href="' + escH(d.base) + '" style="display:inline-block;background:' + G + ';color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 22px;border-radius:8px">Buka dashboard</a></td></tr>' : '<tr><td style="padding:12px"></td></tr>') +
    "</table></td></tr></table></body></html>";
}
async function buildDigest(cfg, base) {
  const st = await M.getStats(2), t = st[0] || {}, y = st[1] || {};
  const used = await M.usedToday(), pz = await M.getPause();
  const q = await hgetall(QUEUE); let pending = 0;
  Object.keys(q).forEach(k => { const v = parse(q[k]); if (v && v.st === "pending") pending++; });
  const seq = await hgetall(SEQ), steps = cfg.mail.steps.length; let active = 0;
  Object.keys(seq).forEach(k => { const v = parse(seq[k]); if (v && v.n < steps) active++; });
  const acc = await serpAccounts();
  const row = (l, a, b) => l.padEnd(24) + String(a == null ? 0 : a).padStart(9) + String(b == null ? 0 : b).padStart(9);
  const year = new Date(Date.now() + 7 * 36e5).getUTCFullYear(), dateStr = shortDate() + " " + year + " (WIB)";
  const L = [];
  L.push("Ringkasan harian " + BRAND.name, dateStr, "");
  L.push(row("", "Hari ini", "Kemarin"));
  L.push(row("Prospek baru", t.added, y.added), row("Punya kontak (hasil cek)", t.found, y.found));
  L.push(row("Email pertama terkirim", t.sent, y.sent), row("Follow-up terkirim", t.fu, y.fu));
  L.push(row("Bounce", t.bounce, y.bounce), row("Lapor spam", t.spam, y.spam), row("Berhenti langganan", t.unsub, y.unsub));
  L.push("", "Hari ini = sejak pukul 07.00 WIB (awal hari UTC), termasuk jalan otomatis ini.", "");
  L.push("Status");
  L.push("- Kirim otomatis: " + (cfg.mail.on ? "aktif" : "nonaktif") + (pz ? " (DIJEDA: " + pz.why + ")" : ""));
  L.push("- Menunggu persetujuan: " + pending + " prospek", "- Follow-up berjalan: " + active, "");
  L.push("Kuota");
  L.push("- Resend hari ini: " + used + (M.DAILY > 0 ? " dari " + M.DAILY + " (sisa " + Math.max(M.DAILY - used, 0) + ")" : " (tanpa batas)"));
  if (acc.length) acc.forEach(a => L.push("- SerpApi akun " + a.n + ": sisa " + a.left + " dari " + a.limit));
  else L.push("- SerpApi: tidak bisa dicek");
  if (base) L.push("", "Buka halaman: " + base);
  // versi HTML (tabel)
  const left = (a, b) => b > 0 ? a / b * 100 : 0, tone = p => p < 10 ? "bad" : p < 20 ? "warn" : "ok";
  const quota = [];
  if (M.DAILY > 0) { const p = used / M.DAILY * 100; quota.push({ label: "Resend hari ini", text: used + " dari " + M.DAILY + " (sisa " + Math.max(M.DAILY - used, 0) + ")", pct: p, tone: p > 90 ? "bad" : p > 80 ? "warn" : "ok" }); }
  else quota.push({ label: "Resend hari ini", text: used + " (tanpa batas)", pct: null });
  if (acc.length) acc.forEach(a => { const p = left(a.left, a.limit); quota.push({ label: "SerpApi akun " + a.n, text: "sisa " + a.left + " dari " + a.limit, pct: p, tone: tone(p) }); });
  else quota.push({ label: "SerpApi", text: "tidak bisa dicek", pct: null });
  const html = renderDigestHtml({
    brand: BRAND.name, date: dateStr, base,
    rows: [["Prospek baru", t.added, y.added], ["Punya kontak (hasil cek)", t.found, y.found], ["Email pertama terkirim", t.sent, y.sent], ["Follow-up terkirim", t.fu, y.fu],
      ["Bounce", t.bounce, y.bounce], ["Lapor spam", t.spam, y.spam], ["Berhenti langganan", t.unsub, y.unsub]],
    status: [["Kirim otomatis", cfg.mail.on ? (pz ? "Dijeda: " + pz.why : "Aktif") : "Nonaktif", pz ? "bad" : cfg.mail.on ? "ok" : "warn"],
      ["Menunggu persetujuan", pending + " prospek", pending > 0 ? "warn" : ""], ["Follow-up berjalan", String(active), ""]],
    quota
  });
  return { subject: "Ringkasan harian " + BRAND.name + ", " + shortDate(), text: L.join("\n"), html };
}
// force = kirim tes (abaikan batas sekali sehari dan pengaturan aktif/nonaktif)
async function sendDigest(cfg, base, force) {
  const n = await M.notifyTarget();
  if (!force && !n.digest) return { skip: "nonaktif" };
  if (!n.to) return { skip: "belum ada email penerima (isi di Pengaturan > Laporan, atau Reply-To di tab Email)" };
  if (!force) { try { if ((await cmd(["HGET", AUTO, "digest"])) === M.today()) return { skip: "sudah terkirim hari ini" }; } catch (e) { /* kirim saja */ } }
  const d = await buildDigest(cfg, base);
  await M.sendNotice(n.to, d.subject, d.text, d.html);
  try { await cmd(["HSET", AUTO, "digest", M.today()]); } catch (e) { /* abaikan */ }
  return { sent: true, to: n.to };
}
const JN = { mail: "Kirim", refresh: "Cari ulang", rotate: "Putaran kota", enrich: "Cari email", queue: "Antrean", clean: "Pembersihan" };
// Dipanggil setelah jalan otomatis (cron). Mengembalikan {digest, alerts:[jenis], err?}
async function notifyAfter(cfg, out, o) {
  const res = { alerts: [] }, j = out.jobs || {};
  const ping = async (kind, subject, text) => { try { if (await M.alertNotice(kind, subject, text)) res.alerts.push(kind); } catch (e) { res.err = e.message; } };
  const errs = [];
  if (o.prevCronT && out.t - o.prevCronT > 30 * 36e5) {
    await ping("missed", "Jadwal harian terlewat", "Jalan otomatis terakhir sebelum ini terjadi " + Math.round((out.t - o.prevCronT) / 36e5) + " jam lalu, padahal seharusnya tiap hari.\n\nCek di Vercel: tab Logs dan Settings > Cron Jobs, serta CRON_SECRET di Environment Variables.");
  }
  if (out.error) errs.push("Pekerjaan gagal: " + out.error);
  for (const k of Object.keys(j)) {
    const e = j[k] && j[k].err; if (!e) continue;
    if (k === "mail" && /kuota|quota|429|terlalu cepat/i.test(e)) await ping("resend_quota", "Kuota Resend habis atau terlalu cepat", "Pengiriman email berhenti: " + e + "\n\nKuota Resend reset pukul 07.00 WIB. Jika sering terjadi, naikkan paket Resend lalu isi RESEND_DAILY_LIMIT di Vercel.");
    else if ((k === "refresh" || k === "rotate") && /SerpApi|kuota|quota|key/i.test(e)) await ping("serp_quota", "Pencarian ulang gagal (SerpApi)", "Pencarian ulang berhenti: " + e + "\n\nCek kuota dan API key SerpApi di Pengaturan. Jika kuota akun habis, ganti ke akun lain lewat switch di pojok kanan atas.");
    else errs.push((JN[k] || k) + ": " + e);
  }
  if (j.refresh && j.refresh.disabled && j.refresh.disabled.length) await ping("serp_dry", "Pencarian ulang dinonaktifkan otomatis", "Pencarian berikut tidak menghasilkan tempat baru berkali-kali berturut-turut, jadi centang cari ulangnya dimatikan supaya kuota SerpApi tidak terbuang:\n\n- " + j.refresh.disabled.join("\n- ") + "\n\nKalau mau diulang lagi, centang kembali di Pengaturan otomatis > Cari ulang.");
  const swj = (j.refresh && j.refresh.switched) || (j.rotate && j.rotate.switched);
  if (swj) await ping("serp_switch", "Akun SerpApi dipindah otomatis", "Akun SerpApi aktif dipindah: " + swj + ".\n\nCek sisa kuota kedua akun di pojok kanan atas. Batas pindah bisa diubah di Pengaturan otomatis > Akun SerpApi.");
  const lowNote = [j.refresh, j.rotate].map(x => x && /dilewati/.test(x.note || "") ? x.note : "").filter(Boolean)[0];
  if (lowNote) await ping("serp_low", "Kuota SerpApi hampir habis", "Pencarian otomatis dilewati: " + lowNote + "\n\nTambah kuota, ganti akun SerpApi, atau turunkan angka \"Sisakan kuota SerpApi\" di Pengaturan otomatis.");
  if (errs.length) await ping("cron", "Jalan otomatis gagal", errs.join("\n") + "\n\nBuka tab Otomatis > Riwayat jalan untuk melihat detailnya.");
  try {
    const d = await sendDigest(cfg, o.base, false);
    res.digest = d.sent ? "terkirim" : d.skip;
  } catch (e) { res.digest = "gagal"; res.err = e.message; }
  return res;
}

// ---- Pengendali -------------------------------------------------------------------------------------------
async function lock() { return (await cmd(["SET", LOCK, "1", "NX", "EX", "120"])) === "OK"; }
async function unlock() { try { await cmd(["DEL", LOCK]); } catch (e) { /* kunci hangus sendiri dalam 2 menit */ } }

// opts: {jobs: "all"|"mail"|"refresh"|"enrich", src: "cron"|"manual", base, budgetMs}
async function runAuto(opts) {
  if (!dbConfigured()) return { error: "Database belum terhubung. Pastikan koneksi Upstash Redis telah dikonfigurasi." };
  if (!(await lock())) return { error: "Proses otomasi sedang berjalan di latar belakang. Silakan coba beberapa saat lagi." };
  const t0 = Date.now(), out = { t: t0, src: opts.src || "manual", jobs: {} };
  const isCron = out.src === "cron";
  let cfg = null, prevCronT = 0;
  try {
    if (isCron) { const prev = (await getLog()).find(e => e.src === "cron"); prevCronT = prev ? prev.t : 0; }
    const budget = opts.budgetMs || (isCron ? 40000 : 44000); // cron menyisakan waktu untuk email laporan
    cfg = await getCfg();
    const why = await M.checkHealth(); // sudah dijeda manual, atau bounce/spam melewati batas: semua pekerjaan berhenti
    const fillOnly = opts.jobs === "intake" || opts.jobs === "queue"; // mengisi antrean setelah cari manual tetap jalan saat dijeda (tidak mengirim apa pun)
    if (why && !fillOnly) out.paused = why;
    else {
      const ctx = { softEnd: t0 + budget, hardEnd: t0 + budget + 6000, base: opts.base || "", force: opts.src === "manual", data: await loadData() };
      const want = j => opts.jobs === "all" || opts.jobs === j || (opts.jobs === "intake" && (j === "enrich" || j === "queue")); // intake = cari email lalu isi antrean (dipakai setelah cari manual)
      const guard = async (name, fn) => { try { out.jobs[name] = await fn(); } catch (e) { out.jobs[name] = { err: e.message }; } };
      if (want("mail")) await guard("mail", () => jobMailSend(cfg, ctx));
      if (want("refresh")) {
        await guard("refresh", () => jobRefresh(cfg, ctx));
        if (out.jobs.refresh && out.jobs.refresh.added) ctx.data = await loadData();
      }
      if (want("rotate")) {
        await guard("rotate", () => jobRotate(cfg, ctx));
        if (out.jobs.rotate && out.jobs.rotate.added) ctx.data = await loadData();
      }
      if (want("enrich")) await guard("enrich", () => jobEnrich(cfg, ctx));
      if (want("mail") || want("queue")) await guard("queue", () => jobQueue(cfg, ctx));
      if (opts.jobs === "all") await guard("clean", () => pruneData(cfg, ctx));
    }
  } catch (e) {
    out.error = e.message;
  } finally {
    await unlock();
  }
  out.ms = Date.now() - t0;
  // Laporan dan peringatan hanya untuk jalan terjadwal (cron). Tetap dikirim walau sedang dijeda, jika masih ada waktu.
  if (isCron && cfg && Date.now() - t0 < 50000) {
    try { out.notify = await notifyAfter(cfg, out, { prevCronT, base: opts.base }); } catch (e) { out.notify = { err: e.message }; }
  }
  if (opts.jobs !== "queue" && opts.jobs !== "intake") { try { await pushLog(out); } catch (e) { /* log gagal tidak penting */ } } // isi antrean otomatis setelah cari manual tidak dicatat, supaya riwayat jalan tidak penuh
  return out;
}

module.exports = { queueWhy, enqueue, scorePreview, rotInfo, nextCity, QUEUE, SEQ, AUTO, LOCK, defaultCfg, sanitizeCfg, getCfg, setCfg, getLog, runAuto, loadData, sendDigest, buildDigest, renderDigestHtml, notifyAfter };
