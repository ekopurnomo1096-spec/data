// Pekerjaan otomatis: dijalankan oleh cron harian (api/auto.js?a=cron) atau tombol "Jalankan sekarang" di tab Otomatis.
//   mail    : kirim follow-up yang sudah waktunya + email pertama yang sudah disetujui (sesuai sisa kuota harian Resend)
//   refresh : cari ulang pencarian tersimpan yang dicentang (hanya tempat baru yang masuk), dengan batas kuota SerpApi
//   enrich  : cari email/WhatsApp dari website tempat yang belum dicek
//   queue   : isi antrean persetujuan dengan prospek yang skornya cukup (skor berbasis aturan, _score.js)
// Semua data di Redis berawalan "hairleads:". Tidak memakai AI.
const { dbConfigured, cmd, hgetall, getKey, getActive } = require("./_store");
const { sanitizeLead } = require("./_leads");
const { findContacts } = require("./_contacts");
const { scoreLead, FREE } = require("./_score");
const { TEMPLATE, BRAND } = require("./_template");
const M = require("./_mail");
const places = require("./places");

const LEADS = "hairleads:leads", CACHE = "hairleads:cache", META = "hairleads:cmeta";
const AUTO = "hairleads:auto", QUEUE = "hairleads:queue", SEQ = "hairleads:seq", LOCK = "hairleads:autolock";
const DAY = 864e5;
const QUEUE_ROOM = 50; // paling banyak segini prospek menunggu persetujuan sekaligus
const parse = M.parse;

// ---- Pengaturan -----------------------------------------------------------------------------------------
const FU1 = "Hi!\n\nJust following up on my earlier message. We supply wholesale human hair extensions (weft, bulk, tape, nano ring, I/U/K/V tip and more) directly from Indonesia.\n\n" +
  "If it helps, we can send you our product list and wholesale prices. Just reply to this email or message us on WhatsApp: " + BRAND.phone + ".\n\nThank you!";
const FU2 = "Hi!\n\nThis is our last note. If you are ever looking for a reliable hair extension supplier, you are welcome to contact us anytime, by replying to this email or on WhatsApp: " +
  BRAND.phone + ".\n\nWebsite: " + BRAND.website + "\n\nHave a great week!";

function defaultCfg() {
  return {
    enrich: { on: true, max: 60 },
    refresh: { on: false, everyDays: 7, maxSearches: 3, reserve: 30, keys: [] },
    mail: {
      on: false, approve: true, minScore: 40, perDay: 20, followOn: true,
      steps: [
        { days: 0, subject: "Human hair extension supplier from Indonesia", text: TEMPLATE },
        { days: 4, subject: "Following up: human hair extension supplier", text: FU1 },
        { days: 10, subject: "Last note: hair extension supplier from Indonesia", text: FU2 }
      ]
    }
  };
}
const num = (v, a, b, d) => { v = Math.round(Number(v)); return isFinite(v) ? Math.max(a, Math.min(b, v)) : d; };
const bool = (v, d) => (typeof v === "boolean" ? v : d);

function sanitizeCfg(c) {
  const d = defaultCfg();
  c = c && typeof c === "object" ? c : {};
  const e = c.enrich || {}, r = c.refresh || {}, m = c.mail || {};
  const out = {
    enrich: { on: bool(e.on, d.enrich.on), max: num(e.max, 1, 200, d.enrich.max) },
    refresh: {
      on: bool(r.on, false), everyDays: num(r.everyDays, 1, 60, 7), maxSearches: num(r.maxSearches, 1, 10, 3), reserve: num(r.reserve, 0, 1000, 30),
      keys: Array.isArray(r.keys) ? [...new Set(r.keys.map(k => String(k).slice(0, 300)).filter(Boolean))].slice(0, 40) : []
    },
    mail: { on: bool(m.on, false), approve: bool(m.approve, true), minScore: num(m.minScore, 0, 100, 40), perDay: num(m.perDay, 1, 100, 20), followOn: bool(m.followOn, true), steps: [] }
  };
  const raw = Array.isArray(m.steps) ? m.steps.slice(0, 4) : d.mail.steps;
  let prev = 0;
  raw.forEach((s, i) => {
    s = s && typeof s === "object" ? s : {};
    const subject = M.clean(s.subject, 200), text = typeof s.text === "string" ? s.text.trim().slice(0, 5000) : "";
    if (i === 0) { out.mail.steps.push({ days: 0, subject: subject || d.mail.steps[0].subject, text: text || d.mail.steps[0].text }); return; }
    if (!subject || !text) return; // follow-up yang kosong dibuang
    prev = Math.max(prev + 1, num(s.days, 1, 60, 4 * i));
    out.mail.steps.push({ days: prev, subject, text });
  });
  if (!out.mail.steps.length) out.mail.steps.push({ days: 0, subject: d.mail.steps[0].subject, text: d.mail.steps[0].text });
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
  for (const e of entries) for (const r of e.results) if (r && r.id && !map.has(r.id)) map.set(r.id, { ...r });
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
  return { map, leads };
}
const firstEmail = x => {
  const e = (x.emails && x.emails.length ? x.emails[0] : x.email) || "";
  const t = String(e).trim().toLowerCase();
  return M.EMAIL.test(t) ? t : "";
};
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
function shortDate() { // "3 Nov" dalam WIB, sama dengan catatan otomatis di halaman
  const d = new Date(Date.now() + 7 * 36e5);
  return d.getUTCDate() + " " + BULAN[d.getUTCMonth()];
}

// ---- Enrich -----------------------------------------------------------------------------------------------
async function jobEnrich(cfg, ctx) {
  if (!cfg.enrich.on) return { skip: "mati" };
  // Yang gagal dijangkau dicoba ulang SEKALI, paling cepat 20 jam kemudian (retry=1). Setelah itu ditandai sudah dicek.
  const t0 = Date.now(), RETRY_AFTER = 20 * 36e5;
  const pool = [...ctx.data.map.values()].filter(x => x.id && x.website && !x.looked);
  const all = pool.filter(x => !(x.retry >= 1 && t0 - (x.rt || 0) < RETRY_AFTER));
  const waiting = pool.length - all.length;
  all.sort((a, b) => (a.retry || 0) - (b.retry || 0)); // yang belum pernah dicek didahulukan
  const todo = all.slice(0, cfg.enrich.max);
  let idx = 0, done = 0, found = 0, failed = 0;
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
      const rec = { s: rec0.s || "", n: rec0.n || "", t: Date.now(), lead };
      await cmd(["HSET", LEADS, x.id, JSON.stringify(rec)]);
      ctx.data.leads[x.id] = rec;
      x.looked = lead.looked; x.found = lead.found; x.retry = lead.retry; x.rt = lead.rt; x.emails = lead.emails; x.email = lead.email; x.wa = lead.wa;
      done++; if (lead.found) found++; if (retryLater) failed++;
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  const out = { done, found, left: Math.max(all.length - done, 0) };
  if (failed) out.retry = failed;
  if (waiting) out.waiting = waiting;
  return out;
}

// ---- Refresh ----------------------------------------------------------------------------------------------
async function serpLeft() {
  try {
    const [k1, k2, act] = await Promise.all([getKey("serp"), getKey("serp2"), getActive()]);
    const a1 = k1 || process.env.SERPAPI_KEY;
    const key = act === "2" && k2 ? k2 : (a1 || k2);
    if (!key) return null;
    const r = await fetch("https://serpapi.com/account.json?api_key=" + encodeURIComponent(key), { headers: { "User-Agent": "hair-leads-demo/1.0" }, signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error || j.searches_per_month == null) return null;
    return j.total_searches_left != null ? Number(j.total_searches_left) : Math.max((Number(j.searches_per_month) || 0) - (Number(j.this_month_usage) || 0), 0);
  } catch (e) { return null; }
}
async function jobRefresh(cfg, ctx) {
  const rc = cfg.refresh;
  if (!rc.on && !ctx.force) return { skip: "mati" };
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
  let left = due.some(d => d.m.source !== "osm") ? await serpLeft() : null;
  let searches = 0, added = 0, err = "", skipped = 0;
  for (const d of due) {
    if (searches >= rc.maxSearches) break;
    if (ctx.softEnd - Date.now() < 30000) break; // satu pencarian bisa sampai 25 detik
    if (d.m.source !== "osm") {
      if (left !== null && left - 1 < rc.reserve) { skipped++; continue; } // sisakan kuota SerpApi
    }
    try {
      const r = await places.searchCore({ city: d.m.city, kind: d.m.kind, source: d.m.source, refresh: true }, { merge: true });
      await cmd(["HSET", AUTO, "rf:" + d.key, String(Date.now())]);
      searches++; added += r.added || 0;
      if (d.m.source !== "osm" && left !== null) left--;
    } catch (e) { err = e.message; if (/SerpApi|kuota|key/i.test(e.message)) break; }
  }
  const out = { searches, added };
  if (skipped) out.note = "dilewati " + skipped + " (sisa kuota SerpApi di bawah batas aman)";
  if (err) out.err = err;
  return out;
}

// ---- Mail: antrean ----------------------------------------------------------------------------------------
async function jobQueue(cfg, ctx) {
  if (!cfg.mail.on) return { skip: "mati" };
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
    const to = firstEmail(x);
    if (!to || mailedTo.has(to) || seenTo.has(to)) continue;
    const sc = scoreLead(x);
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
    args.push(c.x.id, JSON.stringify({ id: c.x.id, to: c.to, name: M.clean(c.x.name, 80), sc: c.sc.s, why: c.sc.why.slice(0, 3), st: cfg.mail.approve ? "pending" : "ok", t: now }));
  }
  for (let i = 0; i < args.length; i += 200) await cmd(["HSET", QUEUE, ...args.slice(i, i + 200)]);
  const res = { added: take.length, pending: pending + (cfg.mail.approve ? take.length : 0), waiting: Math.max(ok.length - take.length, 0) };
  if (badMx) res.noMx = badMx;
  if (dupDomain) res.dupDomain = dupDomain;
  if (pendingMx) res.mxLater = pendingMx;
  return res;
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
  if (!cfg.mail.on) return { skip: "mati" };
  const rc = await M.config();
  if (!rc.key || !/@/.test(rc.from)) return { skip: "Resend belum diisi (API key dan email pengirim)" };
  let used = await M.usedToday();
  const cap = Math.min(cfg.mail.perDay, M.DAILY > 0 ? Math.max(M.DAILY - used, 0) : Infinity);
  if (cap <= 0) return { skip: "kuota email hari ini habis" };
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
    if (mailed.has(id) || (rec && rec.s) || !M.EMAIL.test(q.to || "")) { stale.push(id); continue; }
    fresh.push({ id, to: String(q.to).toLowerCase(), name: q.name || "", n: 0, sc: q.sc || 0, fu: false });
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

  let sent = 0, sentFu = 0, err = "";
  for (let i = 0; i < list.length; i += M.MAX) {
    const chunk = list.slice(i, i + M.MAX);
    try {
      await M.sendBatch(rc, chunk.map(c => ({ to: c.to, subject: steps[c.n].subject, text: M.greet(steps[c.n].text, c.name) })), ctx.base);
    } catch (e) { err = e.message; break; }
    used = await M.recordSent(chunk, used);
    for (const c of chunk) {
      const t = Date.now();
      try {
        const prev = c.fu ? parse(seqRaw[c.id]) : null;
        await cmd(["HSET", SEQ, c.id, JSON.stringify({ to: c.to, name: c.name, n: c.n + 1, first: prev ? prev.first : t, last: t })]);
        if (!c.fu) await cmd(["HDEL", QUEUE, c.id]);
        await markEmailed(ctx, c.id, ctx.data.map.get(c.id) || { name: c.name });
      } catch (e) { /* gagal mencatat tidak boleh menghentikan sisanya; email sudah terkirim */ }
      if (c.fu) sentFu++; else sent++;
    }
  }
  const out = { sent, followups: sentFu };
  if (err) out.err = err;
  return out;
}

// ---- Pengendali -------------------------------------------------------------------------------------------
async function lock() { return (await cmd(["SET", LOCK, "1", "NX", "EX", "120"])) === "OK"; }
async function unlock() { try { await cmd(["DEL", LOCK]); } catch (e) { /* kunci hangus sendiri dalam 2 menit */ } }

// opts: {jobs: "all"|"mail"|"refresh"|"enrich", src: "cron"|"manual", base, budgetMs}
async function runAuto(opts) {
  if (!dbConfigured()) return { error: "Database belum terhubung. Hubungkan Upstash Redis di Vercel lalu Redeploy" };
  if (!(await lock())) return { error: "Pekerjaan otomatis sedang berjalan. Coba lagi sebentar lagi" };
  const t0 = Date.now(), out = { t: t0, src: opts.src || "manual", jobs: {} };
  try {
    const budget = opts.budgetMs || 44000;
    const cfg = await getCfg();
    const ctx = { softEnd: t0 + budget, hardEnd: t0 + budget + 6000, base: opts.base || "", force: opts.src === "manual", data: await loadData() };
    const want = j => opts.jobs === "all" || opts.jobs === j;
    const guard = async (name, fn) => { try { out.jobs[name] = await fn(); } catch (e) { out.jobs[name] = { err: e.message }; } };
    if (want("mail")) await guard("mail", () => jobMailSend(cfg, ctx));
    if (want("refresh")) {
      await guard("refresh", () => jobRefresh(cfg, ctx));
      if (out.jobs.refresh && out.jobs.refresh.added) ctx.data = await loadData();
    }
    if (want("enrich")) await guard("enrich", () => jobEnrich(cfg, ctx));
    if (want("mail")) await guard("queue", () => jobQueue(cfg, ctx));
  } catch (e) {
    out.error = e.message;
  } finally {
    await unlock();
  }
  out.ms = Date.now() - t0;
  try { await pushLog(out); } catch (e) { /* log gagal tidak penting */ }
  return out;
}

module.exports = { QUEUE, SEQ, AUTO, defaultCfg, sanitizeCfg, getCfg, setCfg, getLog, runAuto, loadData };
