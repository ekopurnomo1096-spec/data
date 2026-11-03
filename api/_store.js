// Penyimpanan API key di Upstash Redis (lewat REST, tanpa dependensi). Nilai dienkripsi AES-256-GCM.
// Kunci enkripsi diturunkan dari APP_PASSWORD. Kalau APP_PASSWORD diganti, key harus diisi ulang.
// Database boleh dipakai bersama project lain: semua data di sini berawalan "hairleads:".
const crypto = require("crypto");
const HASH = "hairleads:keys";

function findEnv(names) {
  for (const n of names) if (process.env[n]) return process.env[n];
  for (const k of Object.keys(process.env)) {
    if (names.some(n => k.endsWith("_" + n)) && process.env[k]) return process.env[k];
  }
  return "";
}
const URL_ = () => findEnv(["UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"]).replace(/\/+$/, "");
const TOKEN = () => findEnv(["UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN"]);
const dbConfigured = () => !!(URL_() && TOKEN());

async function cmd(args) {
  const r = await fetch(URL_(), {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN(), "Content-Type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("Redis: " + (j.error || r.status));
  return j.result;
}

let K = null;
function encKey() {
  if (!K) K = crypto.scryptSync(process.env.APP_PASSWORD || "", "hair-leads-apikeys-v1", 32);
  return K;
}
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
function decrypt(s) {
  try {
    const b = Buffer.from(String(s).slice(3), "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", encKey(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  } catch (e) { return ""; }
}

// name: "serp" | "geo". Mengembalikan "" kalau belum ada / tidak bisa dibaca.
async function getKey(name) {
  if (!dbConfigured()) return "";
  try {
    const v = await cmd(["HGET", HASH, name]);
    return v ? decrypt(v) : "";
  } catch (e) { return ""; }
}
async function setKey(name, value) {
  if (value) await cmd(["HSET", HASH, name, encrypt(value)]);
  else await cmd(["HDEL", HASH, name]);
}

// Akun SerpApi yang dipakai untuk pencarian: "1" atau "2" (disimpan di server, jadi sama di semua browser)
async function getActive() {
  if (!dbConfigured()) return "1";
  try { return (await cmd(["HGET", HASH, "active"])) === "2" ? "2" : "1"; } catch (e) { return "1"; }
}
async function setActive(v) { await cmd(["HSET", HASH, "active", v === "2" ? "2" : "1"]); }

module.exports = { dbConfigured, getKey, setKey, getActive, setActive };
