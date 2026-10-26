// Keep newly created credentials, database and temporary files private.
process.umask(0o077);

require("dotenv").config();

const REQUIRED_ENV = ["OWNER"];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
    console.error(`❌ Env var wajib belum diset: ${missing.join(", ")}`);
    console.error("   Cek file .env (lihat .env.example sebagai contoh).");
    process.exit(1);
}

// NOTE: pembuatan folder ./temp sekarang ditangani oleh ensureTempDir()
// di lib/features/sticker.js (dipanggil dari startBot()), jadi nggak perlu
// diduplikasi di sini. Sebelumnya ada 2 folder temp berbeda yang dibuat
// (root ./temp yang nganggur, dan lib/temp yang beneran dipakai).

require("./config/ai").settings();

const { startBot, stopBot } = require("./lib/bot/connection");

// Jaring pengaman terakhir: kalau ada promise rejection atau exception
// yang lolos dari try/catch di connection.js, log dulu daripada bot
// mati diam-diam tanpa jejak.
process.on("unhandledRejection", (reason) => {
    console.error("⚠️  Unhandled Rejection:", reason instanceof Error ? reason.message : "Unknown rejection");
});
process.on("uncaughtException", (err) => {
    console.error("⚠️  Uncaught Exception:", err.message);
    process.exit(1);
});

startBot().catch((err) => {
    console.error("Gagal memulai bot:", err.message);
    process.exit(1);
});

let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), 200000);
    try {
        await stopBot();
        clearTimeout(deadline);
        process.exit(0);
    } catch (error) {
        console.error("Gagal menghentikan bot dengan aman:", error.message);
        process.exit(1);
    }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
