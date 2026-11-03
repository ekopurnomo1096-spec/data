// Pembantu login: cookie sesi bertanda tangan (HMAC). Kunci diturunkan dari APP_PASSWORD.
const crypto = require("crypto");
const COOKIE = "hl_session";
const DAYS = 30;
let K = null;

function key() {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return null;
  if (!K) K = crypto.scryptSync(pw, "hair-leads-session-v1", 32);
  return K;
}
function sign(exp, k) { return crypto.createHmac("sha256", k).update("s:" + exp).digest("hex"); }
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function cookies(h) {
  const o = {};
  String(h || "").split(";").forEach(p => { const i = p.indexOf("="); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return o;
}
function isAuthed(req) {
  const k = key();
  if (!k) return false;
  const t = cookies(req.headers && req.headers.cookie)[COOKIE];
  if (!t) return false;
  const [exp, sig] = t.split(".");
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  return safeEq(sig, sign(exp, k));
}
function makeToken() {
  const exp = Date.now() + DAYS * 864e5;
  return exp + "." + sign(exp, key());
}
function cookieHeader(token, maxAge) {
  return COOKIE + "=" + token + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + maxAge;
}
function passwordOk(pw) {
  const h = s => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(h(pw), h(process.env.APP_PASSWORD || ""));
}
module.exports = { isAuthed, makeToken, cookieHeader, passwordOk, DAYS };
