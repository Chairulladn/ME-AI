require("dotenv").config();

const REQUIRED_ENV = ["OWNER"];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
    console.error(`❌ Env var wajib belum diset: ${missing.join(", ")}`);
    console.error("   Cek file .env (lihat .env.example sebagai contoh).");
    process.exit(1);
}

// NOTE: pembuatan folder ./temp sekarang ditangani oleh ensureTempDir()
// di lib/sticker.js (dipanggil dari startBot()), jadi nggak perlu
// diduplikasi di sini. Sebelumnya ada 2 folder temp berbeda yang dibuat
// (root ./temp yang nganggur, dan lib/temp yang beneran dipakai).

const { startBot } = require("./lib/connection");

// Jaring pengaman terakhir: kalau ada promise rejection atau exception
// yang lolos dari try/catch di connection.js, log dulu daripada bot
// mati diam-diam tanpa jejak.
process.on("unhandledRejection", (reason) => {
    console.error("⚠️  Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
    console.error("⚠️  Uncaught Exception:", err);
});

startBot();
