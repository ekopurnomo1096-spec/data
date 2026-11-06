// Template pesan cold outreach awal. Digunakan bersama oleh ai.js dan send.js.
// Silakan sesuaikan isi pesan dan metadata brand di bawah ini sesuai kebutuhan bisnis Anda.
const TEMPLATE = `Hi! We’re a human hair supplier from Indonesia, specializing in hair extensions:

• Hair Weft
• Hair Bulk
• I/U/K/V Tip
• Nano Ring
• Tape Hair
• Genius Weft & more

We offer high-quality products, competitive wholesale prices, and reliable service.

If you’re looking for a reliable hair supplier, feel free to DM us or contact us via WhatsApp:

+62 895-3799-94528

Website :
https://emahairshop.com/

Looking forward to working with you!`;

// Data brand dipakai untuk header/footer HTML email (lihat send.js) dan sebagai fakta
// yang boleh dipakai AI saat menulis email (lihat ai.js). Ubah di sini jika datanya berubah.
const BRAND = {
  name: "EMAHAIRSHOP",
  tagline: "Human hair supplier from Indonesia",
  phone: "+62 895-3799-94528",
  waLink: "https://wa.me/6289537994528",
  website: "https://emahairshop.com/",
  products: ["Hair Weft", "Hair Bulk", "I/U/K/V Tip", "Nano Ring", "Tape Hair", "Genius Weft"]
};

module.exports = { TEMPLATE, BRAND };
