// Pembersihan data lama supaya Upstash gratis tidak penuh. Dipanggil dari _jobs.js, paling banyak sekali per 20 jam.
// Yang dibuang (hanya dari pencarian yang umurnya melebihi batas hari DAN tidak dicentang untuk cari ulang):
//   - tempat TANPA KONTAK: tanpa telepon, email, dan WhatsApp, dan websitenya sudah dicek (atau tidak punya website)
//   - pencarian yang jadi kosong setelah itu
//   - skor AI dan catatan cek email milik tempat yang dibuang (jika tidak dipakai pencarian lain)
//   - cache pengecekan domain email yang sudah kedaluwarsa, dan statistik harian lebih dari 90 hari
// TIDAK PERNAH dibuang: tempat yang punya status/catatan, pernah dikirimi email, ada di antrean, atau urutan follow-up.
const { dbConfigured, cmd, hgetall } = require("./_store");
const M = require("./_mail");

const LEADS = "hairleads:leads", CACHE = "hairleads:cache", META = "hairleads:cmeta", AI = "hairleads:ai";
const AUTO = "hairleads:auto", QUEUE = "hairleads:queue", SEQ = "hairleads:seq", MXK = "hairleads:mx", STATK = "hairleads:stats";
const DAY = 864e5, MIN_GAP = 20 * 36e5, PER_RUN = 40, STAT_DAYS = 90;
const parse = M.parse;
const hdel = async (key, ids) => { for (let i = 0; i < ids.length; i += 200) await cmd(["HDEL", key, ...ids.slice(i, i + 200)]); };
const arr = v => (Array.isArray(v) ? v : []);

async function pruneData(cfg, ctx) {
  const c = (cfg && cfg.clean) || { on: true, days: 30 };
  if (!c.on) return { skip: "nonaktif" };
  if (!dbConfigured()) return { skip: "database belum terhubung" };
  const now = Date.now();
  let last = null;
  try { last = parse(await cmd(["HGET", AUTO, "pruned"])); } catch (e) { /* belum pernah */ }
  if (last && now - last.t < MIN_GAP) return { skip: "sudah dibersihkan dalam 20 jam terakhir" };

  const out = { places: 0, searches: 0, mx: 0, stats: 0 };
  const softEnd = (ctx && ctx.softEnd) || now + 30000;
  const leads = (ctx && ctx.data && ctx.data.leads) || {};
  const refs = (ctx && ctx.data && ctx.data.refs) || new Map();
  const ageMs = c.days * DAY, keep = new Set((cfg && cfg.refresh && cfg.refresh.keys) || []);

  try {
    const [mailed, queued, seqd, meta] = await Promise.all([
      cmd(["HKEYS", M.MAIL]), cmd(["HKEYS", QUEUE]), cmd(["HKEYS", SEQ]), hgetall(META)]);
    const protectedIds = new Set([...arr(mailed), ...arr(queued), ...arr(seqd)]);
    const due = [];
    for (const k of Object.keys(meta)) {
      if (keep.has(k)) continue;
      const m = parse(meta[k]);
      if (m && m.at && now - m.at > ageMs) due.push({ k, m });
    }
    due.sort((a, b) => a.m.at - b.m.at);
    const aiDel = [], leadDel = [];
    for (const d of due.slice(0, PER_RUN)) {
      if (Date.now() > softEnd) break;
      const e = parse(await cmd(["HGET", CACHE, d.k]));
      if (!e || !Array.isArray(e.results)) { await cmd(["HDEL", META, d.k]); out.searches++; continue; }
      if (e.pr && now - e.pr < ageMs) continue; // sudah diperiksa belum lama ini
      const kept = [], dropped = [];
      for (const x of e.results) {
        const id = x && x.id;
        if (!id) { kept.push(x); continue; }
        const rec = leads[id] || null, l = (rec && rec.lead) || {};
        const used = (rec && (rec.s || rec.n)) || protectedIds.has(id);
        const contact = x.phone || x.email || x.wa || l.phone || l.email || l.wa || arr(x.emails).length || arr(l.emails).length;
        const unchecked = x.website && !l.looked; // websitenya belum sempat dicek: jangan dibuang dulu
        if (used || contact || unchecked) kept.push(x); else dropped.push(id);
      }
      if (!dropped.length) { await cmd(["HSET", CACHE, d.k, JSON.stringify({ ...e, pr: now })]); continue; }
      if (!kept.length) { await cmd(["HDEL", CACHE, d.k]); await cmd(["HDEL", META, d.k]); out.searches++; }
      else {
        await cmd(["HSET", CACHE, d.k, JSON.stringify({ ...e, results: kept, pr: now })]);
        await cmd(["HSET", META, d.k, JSON.stringify({ ...d.m, n: kept.length })]);
      }
      out.places += dropped.length;
      for (const id of dropped) {
        const left = (refs.get(id) || 1) - 1;
        refs.set(id, left);
        if (left > 0) continue; // masih dipakai pencarian lain
        aiDel.push(id);
        const rec = leads[id];
        if (rec && !rec.s && !rec.n) leadDel.push(id);
      }
    }
    if (aiDel.length) await hdel(AI, aiDel);
    if (leadDel.length) await hdel(LEADS, leadDel);
  } catch (e) { out.err = e.message; }

  try { // cache pengecekan domain email yang sudah kedaluwarsa (valid 14 hari, gagal 3 hari)
    const mx = await hgetall(MXK), old = [];
    Object.keys(mx).forEach(d => { const v = parse(mx[d]); if (!v || now - (v.t || 0) > (v.ok ? 14 : 3) * DAY) old.push(d); });
    if (old.length) { await hdel(MXK, old); out.mx = old.length; }
  } catch (e) { out.err = out.err || e.message; }

  try { // statistik harian lebih dari 90 hari
    const cut = new Date(now - STAT_DAYS * DAY).toISOString().slice(0, 10);
    const old = arr(await cmd(["HKEYS", STATK])).filter(f => String(f).slice(0, 10) < cut);
    if (old.length) { await hdel(STATK, old); out.stats = old.length; }
  } catch (e) { out.err = out.err || e.message; }

  try { await cmd(["HSET", AUTO, "pruned", JSON.stringify({ t: now, places: out.places, searches: out.searches, mx: out.mx, stats: out.stats })]); } catch (e) { /* abaikan */ }
  return out;
}

module.exports = { pruneData };
