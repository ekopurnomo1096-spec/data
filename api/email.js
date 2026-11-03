// Cari email dan WhatsApp dari website sebuah bisnis (gratis, tanpa API key). Logikanya ada di _contacts.js.
const { isAuthed } = require("./_auth");
const { findContacts } = require("./_contacts");

module.exports = async (req, res) => {
  try {
    if (!isAuthed(req)) return res.status(401).json({ error: "Belum login" });
    const out = await findContacts((req.query && req.query.url) || "");
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.status(200).json(out);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
};
