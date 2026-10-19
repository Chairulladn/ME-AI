const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(process.cwd(), "database.json");
const MAX_HISTORY = 20;

// OWNER bisa berisi lebih dari satu nomor, dipisah koma:
// OWNER=628123456789,628987654321
function extractOwnerNumbers() {
    const raw = process.env.OWNER || "";
    return new Set(
        raw
            .split(",")
            .map((n) => n.trim().split("@")[0])
            .filter(Boolean)
    );
}

const OWNER_NUMBERS = extractOwnerNumbers();

function checkOwner(senderNumber) {
    if (!senderNumber) return false;
    return OWNER_NUMBERS.has(senderNumber);
}

function loadDatabase() {
    try {
        const raw = fs.readFileSync(DB_PATH, "utf-8");
        const db = JSON.parse(raw);
        if (!db || typeof db !== "object" || !db.users) {
            return { users: {} };
        }
        return db;
    } catch (err) {
        // File belum ada atau corrupt -> mulai dari database kosong
        // daripada bikin bot crash saat startup.
        if (err.code !== "ENOENT") {
            console.error("⚠️  database.json rusak/tidak terbaca, mulai baru:", err.message);
        }
        return { users: {} };
    }
}

// Tulis atomik: tulis ke file sementara dulu lalu rename.
// Ini mencegah database.json korup kalau proses mati/crash
// persis di tengah proses fs.writeFileSync.
function saveDatabase(db) {
    const tmpPath = `${DB_PATH}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2));
        fs.renameSync(tmpPath, DB_PATH);
    } catch (err) {
        console.error("❌ Gagal menyimpan database:", err.message);
        try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    }
}

function getUser(db, remoteJid) {
    if (!db.users[remoteJid]) {
        db.users[remoteJid] = {
            chat: 0,
            greeted: false,
            ownerGreeted: false,
            name: "Tanpa Nama",
            history: [],
        };
    }
    return db.users[remoteJid];
}

function incrementChat(db, remoteJid) {
    const user = getUser(db, remoteJid);
    user.chat += 1;
    return user;
}

function updateUserName(db, remoteJid, name) {
    const user = getUser(db, remoteJid);
    if (name) user.name = name;
    return user;
}

function pushHistory(db, remoteJid, role, content) {
    const user = getUser(db, remoteJid);
    if (!user.history) user.history = [];
    user.history.push({ role, content });
    if (user.history.length > MAX_HISTORY) {
        user.history = user.history.slice(-MAX_HISTORY);
    }
    return user;
}

function resetDatabase() {
    const db = { users: {} };
    saveDatabase(db);
    return db;
}

module.exports = {
    loadDatabase,
    saveDatabase,
    getUser,
    incrementChat,
    updateUserName,
    pushHistory,
    resetDatabase,
    checkOwner,
    OWNER_NUMBERS,
};
