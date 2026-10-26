const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { assertActive } = require('./jobs');
const DB_PATH = path.join(process.cwd(), 'database.json');
const BACKUP_DIR = path.join(process.cwd(), 'backups');
const MAX_HISTORY = 20;
const OWNER_NUMBERS = new Set((process.env.OWNER || '').split(',').map(n => n.trim().split('@')[0]).filter(n => /^\d+$/.test(n)));
let dirtyDb;
let timer;
let waiters = [];
let writing = Promise.resolve();
let lastBackup = 0;

function checkOwner(number) { return Boolean(number && OWNER_NUMBERS.has(number)); }
function validateDatabase(db) {
    if (!db || typeof db !== 'object' || !db.users || typeof db.users !== 'object' || Array.isArray(db.users)) {
        throw new Error('Struktur database tidak valid');
    }
    for (const user of Object.values(db.users)) {
        if (!user || typeof user !== 'object' || !Array.isArray(user.history) || !Number.isFinite(user.chat)) {
            throw new Error('Data pengguna tidak valid');
        }
        for (const entry of user.history) {
            if (!entry || !['user', 'assistant'].includes(entry.role) || typeof entry.content !== 'string') {
                throw new Error('Riwayat pengguna tidak valid');
            }
        }
    }
    if (db.limits && (!Array.isArray(db.limits.heavy) || db.limits.heavy.some(t => !Number.isFinite(t)))) {
        throw new Error('Data kuota tidak valid');
    }
    return db;
}
function readValidated(file) { return validateDatabase(JSON.parse(fs.readFileSync(file, 'utf8'))); }
function loadDatabase() {
    let db;
    try {
        db = readValidated(DB_PATH);
    } catch (error) {
        const candidates = fs.existsSync(BACKUP_DIR)
            ? fs.readdirSync(BACKUP_DIR).filter(n => /^database-\d+\.json$/.test(n)).sort().reverse() : [];
        for (const name of candidates) {
            try {
                db = readValidated(path.join(BACKUP_DIR, name));
                // Preserve the damaged primary before restoring a validated backup.
                if (fs.existsSync(DB_PATH)) {
                    const preserved = `${DB_PATH}.corrupt-${Date.now()}`;
                    fs.copyFileSync(DB_PATH, preserved);
                    fs.chmodSync(preserved, 0o600);
                }
                const tmp = `${DB_PATH}.${process.pid}.tmp`;
                fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
                fs.renameSync(tmp, DB_PATH);
                console.warn('[database] dipulihkan dari backup tervalidasi');
                break;
            } catch (backupError) {
                if (db) throw new Error('Gagal memulihkan database', { cause: backupError });
            }
        }
        if (!db) {
            if (error.code === 'ENOENT' && candidates.length === 0) db = { users: {} };
            else throw new Error('Database tidak dapat dibaca; pulihkan file sebelum menjalankan bot', { cause: error });
        }
    }
    db.limits ||= { heavy: [] };
    for (const user of Object.values(db.users)) {
        if (!user.lastActive) user.lastActive = Date.now();
        else if (Date.now() - user.lastActive > 30 * 86400000) user.history = [];
    }
    return db;
}

async function atomicWrite(file, content) {
    const temp = `${file}.${process.pid}.tmp`;
    let handle;
    try {
        handle = await fsp.open(temp, 'w', 0o600);
        await handle.chmod(0o600);
        await handle.writeFile(content);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fsp.rename(temp, file);
    } finally {
        await handle?.close().catch(() => {});
        await fsp.rm(temp, { force: true }).catch(() => {});
    }
}
async function writeSnapshot(content) {
    // Save the new database first. Never claim success on failed writes.
    await atomicWrite(DB_PATH, content);
    if (Date.now() - lastBackup >= 3600000) {
        await fsp.mkdir(BACKUP_DIR, { recursive: true, mode: 0o700 });
        await fsp.chmod(BACKUP_DIR, 0o700);
        const file = path.join(BACKUP_DIR, `database-${Date.now()}.json`);
        await atomicWrite(file, content);
        lastBackup = Date.now();
        const names = (await fsp.readdir(BACKUP_DIR)).filter(n => /^database-\d+\.json$/.test(n)).sort().reverse();
        for (const name of names.slice(7)) await fsp.unlink(path.join(BACKUP_DIR, name));
    }
}
function dispatchSave() {
    clearTimeout(timer);
    timer = undefined;
    if (!dirtyDb) return writing;
    const db = dirtyDb;
    const pending = waiters;
    dirtyDb = undefined;
    waiters = [];
    let snapshot;
    try { snapshot = JSON.stringify(validateDatabase(db)); }
    catch (error) {
        pending.forEach(w => w.reject(error));
        writing = Promise.reject(error);
        writing.catch(() => {});
        return writing;
    }
    writing = writing.catch(() => {}).then(() => writeSnapshot(snapshot));
    writing.then(() => pending.forEach(w => w.resolve()), error => pending.forEach(w => w.reject(error)));
    return writing;
}
function saveDatabase(db) {
    assertActive();
    dirtyDb = db;
    const result = new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    if (!timer) timer = setTimeout(dispatchSave, 100);
    return result;
}
function scheduleDatabaseSave(db) {
    void saveDatabase(db).catch(error => console.error('[database] gagal menyimpan:', error.message));
}
async function flushDatabase() { await dispatchSave(); }
function getUser(db, id) {
    assertActive();
    db.users[id] ||= { chat: 0, greeted: false, ownerGreeted: false, name: 'Tanpa Nama', history: [] };
    return db.users[id];
}
function incrementChat(db, id) {
    const user = getUser(db, id);
    if (user.lastActive && Date.now() - user.lastActive > 30 * 86400000) user.history = [];
    user.lastActive = Date.now();
    user.chat++;
    return user;
}
function updateUserName(db, id, name) {
    const user = getUser(db, id);
    if (name) user.name = String(name).slice(0, 80);
    return user;
}
function pushHistory(db, id, role, content) {
    const user = getUser(db, id);
    user.history.push({ role, content: String(content).slice(0, 4000) });
    user.history = user.history.slice(-MAX_HISTORY);
    return user;
}
async function checkDailyLimit(db, { max = 500, windowMs = 86400000 } = {}) {
    assertActive();
    db.limits ||= { heavy: [] };
    const now = Date.now();
    const fresh = db.limits.heavy.filter(t => now - t < windowMs);
    if (fresh.length >= max) return { allowed: false, retryAfterMs: windowMs - (now - fresh[0]) };
    const previous = db.limits.heavy;
    db.limits.heavy = [...fresh, now];
    try { await saveDatabase(db); }
    catch (error) { assertActive(); db.limits.heavy = previous; throw error; }
    assertActive();
    return { allowed: true };
}
module.exports = { loadDatabase, saveDatabase, scheduleDatabaseSave, flushDatabase, getUser,
    incrementChat, updateUserName, pushHistory, checkOwner, checkDailyLimit, OWNER_NUMBERS, validateDatabase };
