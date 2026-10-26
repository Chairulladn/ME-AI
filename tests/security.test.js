const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const jobs = require('../lib/core/jobs');
const { resolveSenderNumber } = require('../lib/bot/identity');
const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
function load(file, overrides = {}) {
    const context = { module: { exports: {} }, require, console, process,
        Buffer, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval,
        ...overrides };
    vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
    return context.module.exports;
}
function database(temp, customFs = fsp) {
    return load('lib/core/database.js', {
        process: { cwd: () => temp, env: { OWNER: '628123' }, pid: process.pid },
        require(name) {
            if (name === '../core/jobs' || name === './jobs') return jobs;
            if (name === 'node:fs/promises') return customFs;
            return require(name);
        },
    });
}
async function temporary(work) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meai-test-'));
    try { await work(dir); }
    finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

test('rate limit expiration survives periodic cleanup', () => {
    let cleanup;
    let now = 0;
    const { checkLimit } = load('lib/core/rateLimiter.js', {
        Date: { now: () => now },
        setInterval(fn) { cleanup = fn; return { unref() {} }; },
    });
    assert.equal(checkLimit('daily', { max: 1, windowMs: 86400000 }).allowed, true);
    now = 600000; cleanup();
    assert.equal(checkLimit('daily', { max: 1, windowMs: 86400000 }).allowed, false);
    now = 86400001;
    assert.equal(checkLimit('daily', { max: 1, windowMs: 86400000 }).allowed, true);
});

test('database coalesces writes, creates private backup and recovers corruption', async () => temporary(async dir => {
    const store = database(dir);
    const db = store.loadDatabase();
    store.getUser(db, 'test@s.whatsapp.net');
    store.pushHistory(db, 'test@s.whatsapp.net', 'user', 'x'.repeat(5000));
    const a = store.saveDatabase(db);
    const b = store.saveDatabase(db);
    await Promise.all([a, b]);
    const file = path.join(dir, 'database.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(db.users['test@s.whatsapp.net'].history[0].content.length, 4000);
    const backupDir = path.join(dir, 'backups');
    assert.equal(fs.readdirSync(backupDir).length, 1);
    assert.equal(fs.statSync(backupDir).mode & 0o777, 0o700);
    fs.writeFileSync(file, '{invalid');
    const recovered = store.loadDatabase();
    assert.equal(recovered.users['test@s.whatsapp.net'].chat, 0);
    assert.ok(fs.readdirSync(dir).some(n => n.includes('.corrupt-')));
}));

test('corrupt database with no backup remains untouched', async () => temporary(async dir => {
    const file = path.join(dir, 'database.json');
    fs.writeFileSync(file, '{invalid');
    assert.throws(() => database(dir).loadDatabase(), /Database tidak dapat dibaca/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
}));

test('disk full errors reach callers and preserve original file', async () => temporary(async dir => {
    const file = path.join(dir, 'database.json');
    const original = JSON.stringify({ users: {} });
    fs.writeFileSync(file, original);
    const store = database(dir, { ...fsp, open: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
    await assert.rejects(store.saveDatabase({ users: {} }), { code: 'ENOSPC' });
    assert.equal(fs.readFileSync(file, 'utf8'), original);
}));

test('daily quota survives module restart and is not reset by deleting users', async () => temporary(async dir => {
    const first = database(dir);
    const db = first.loadDatabase();
    assert.equal((await first.checkDailyLimit(db, { max: 1 })).allowed, true);
    db.users = {}; await first.saveDatabase(db);
    const second = database(dir);
    assert.equal((await second.checkDailyLimit(second.loadDatabase(), { max: 1 })).allowed, false);
}));

test('failed quota persistence rolls back and refuses admission', async () => temporary(async dir => {
    const store = database(dir, { ...fsp, open: async () => { throw new Error('disk full'); } });
    const db = store.loadDatabase();
    await assert.rejects(store.checkDailyLimit(db), /disk full/);
    assert.equal(db.limits.heavy.length, 0);
}));

function mediaModule(download, onDestroy = () => {}, timers = {}) {
    return load('lib/core/media.js', {
        ...timers,
        require(name) {
            if (name === '../core/jobs' || name === './jobs') return jobs;
            if (name === 'undici') return { Agent: class { async destroy(reason) { onDestroy(reason); } } };
            return { downloadMediaMessage: download };
        },
    });
}
test('media validates metadata and actual streamed byte count', async () => {
    let calls = 0;
    let chunks = [Buffer.from('ok')];
    const { downloadBoundedMedia: download } = mediaModule(async () => { calls++; return Readable.from(chunks); });
    await assert.rejects(download({ message: { imageMessage: { fileLength: 11 * 1024 * 1024 } } }), /10 MB/);
    await assert.rejects(download({ message: { audioMessage: { seconds: 121 } } }), /120 detik/);
    assert.equal(calls, 0);
    chunks = [Buffer.alloc(6 * 1024 * 1024), Buffer.alloc(6 * 1024 * 1024)];
    await assert.rejects(download({ message: { imageMessage: {} } }), /10 MB/);
    chunks = [Buffer.from('ok')];
    assert.equal((await download({ message: { imageMessage: {} } })).toString(), 'ok');
});

test('timeout destroys dispatcher even before HTTP headers arrive', async () => {
    let destroyed = false;
    const { downloadBoundedMedia: download } = mediaModule(
        async () => new Promise(() => {}),
        () => { destroyed = true; },
        { setTimeout: fn => setTimeout(fn, 5) },
    );
    await assert.rejects(download({ message: { imageMessage: {} } }), /timeout/);
    assert.equal(destroyed, true);
});

test('LID owner resolution uses transport mapping and fails closed for unknown LID', async () => {
    const sock = { signalRepository: { lidMapping: { getPNForLID: async () => '628123:2@s.whatsapp.net' } } };
    assert.equal(await resolveSenderNumber(sock, { key: { remoteJid: '123@lid' } }), '628123');
    assert.equal(await resolveSenderNumber({}, { key: { remoteJid: '628123@lid' }, pushName: '628123' }), null);
    assert.equal(await resolveSenderNumber({}, { key: { remoteJid: '123@lid', remoteJidAlt: '628123@s.whatsapp.net' } }), '628123');
});

test('queue times out a stuck send, rejects late mutations and processes next job', async () => {
    const errors = [];
    const queue = new jobs.JobQueue({ timeoutMs: 10, onError: e => errors.push(e), capacity: 2 });
    let next = false;
    let lateRejected = false;
    const sock = jobs.guardedSocket({ sendMessage: () => new Promise(() => {}) });
    assert.equal(queue.enqueue(async () => { await sock.sendMessage('chat', {}); }), true);
    assert.equal(queue.enqueue(async () => { next = true; }), true);
    assert.equal(queue.enqueue(async () => {}), false);
    await queue.tail;
    assert.equal(next, true);
    assert.equal(errors.length, 1);
    const second = new jobs.JobQueue({ timeoutMs: 5, onError() {} });
    let release;
    second.enqueue(async () => {
        await new Promise(resolve => { release = resolve; });
        try { jobs.assertActive(); } catch (_) { lateRejected = true; }
    });
    await second.tail;
    release(); await tick();
    assert.equal(lateRejected, true);
});

test('shutdown waits for active job and skips queued jobs', async () => {
    const queue = new jobs.JobQueue();
    let release;
    let skipped = true;
    queue.enqueue(() => new Promise(resolve => { release = resolve; }));
    queue.enqueue(async () => { skipped = false; });
    await tick();
    const stopping = queue.stop();
    assert.equal(queue.enqueue(async () => {}), false);
    release(); await stopping;
    assert.equal(queue.pending, 0);
    assert.equal(skipped, true);
});

function commands() {
    return load('lib/bot/commands.js', { require(name) {
        if (name === '../core/database') return { checkOwner: n => n === 'owner' };
        if (name === '../core/jobs' || name === './jobs') return jobs;
        return require(name);
    } });
}
test('reset rejects unauthorized users and restores memory when persistence fails', async () => {
    const db = { users: { example: {} }, limits: { heavy: [1] } };
    const sock = { async sendMessage() {} };
    await commands().handleResetdb(sock, 'chat', 'other', async () => {}, db);
    assert.equal(Object.keys(db.users).length, 1);
    await assert.rejects(commands().handleResetdb(sock, 'chat', 'owner', async () => { throw new Error('disk full'); }, db), /disk full/);
    assert.equal(Object.keys(db.users).length, 1);
    await commands().handleResetdb(sock, 'chat', 'owner', async () => {}, db);
    assert.equal(Object.keys(db.users).length, 0);
    assert.equal(db.limits.heavy.length, 1);
});

function connectionHarness({ failFetch = () => false } = {}) {
    const sockets = [];
    const replies = [];
    const timers = [];
    const db = { users: {}, limits: { heavy: [] } };
    const database = {
        loadDatabase: () => db, async saveDatabase() {}, scheduleDatabaseSave() {}, async flushDatabase() {},
        checkOwner: () => false, checkDailyLimit: async () => ({ allowed: true }),
        getUser(db, id) { db.users[id] ||= { greeted: true, history: [], chat: 0 }; },
        incrementChat(db, id) { db.users[id].chat++; }, updateUserName() {},
    };
    const api = load('lib/bot/connection.js', {
        setTimeout(fn, delay) { const timer = { fn, delay }; timers.push(timer); return timer; },
        clearTimeout(timer) { if (timer) timer.cancelled = true; },
        require(name) {
            if (name === '@whiskeysockets/baileys') return {
                default() {
                    const events = new Map();
                    const sock = {
                        events, ev: { on(n, fn) { events.set(n, fn); }, removeAllListeners(n) { events.delete(n); } },
                        async sendMessage(to, payload) { replies.push({ to, payload }); },
                        async sendPresenceUpdate() {}, end() { sock.closed = true; },
                    };
                    sockets.push(sock); return sock;
                },
                useMultiFileAuthState: async () => ({ state: {}, saveCreds() {} }),
                fetchLatestBaileysVersion: async () => { if (failFetch()) throw new Error('offline'); return { version: [] }; },
                DisconnectReason: { loggedOut: 401 },
            };
            if (name === '../core/database') return database;
            if (name === '../core/jobs' || name === './jobs') return jobs;
            if (name === './identity') return { resolveSenderNumber };
            if (name === 'pino') return () => ({});
            if (name === 'undici') return require('undici');
            if (name === '../core/rateLimiter') return { checkLimit: () => ({ allowed: true }) };
            if (name === '../features/sticker') return { ensureTempDir() {} };
            return {};
        },
    });
    return { api, sockets, replies, timers, db };
}

test('connection handles message batches, ignores history and deduplicates', async () => {
    const h = connectionHarness();
    const sock = await h.api.startBot();
    const incoming = sock.events.get('messages.upsert');
    const message = (id, user) => ({ key: { id, remoteJid: `${user}@s.whatsapp.net` }, message: { conversation: '/menu' } });
    incoming({ type: 'append', messages: [message('old', 'history')] });
    incoming({ type: 'notify', messages: [message('one', 'alice'), message('two', 'bob')] });
    incoming({ type: 'notify', messages: [message('one', 'alice')] });
    await tick();
    assert.deepEqual(h.replies.map(r => r.to), ['alice@s.whatsapp.net', 'bob@s.whatsapp.net']);
    assert.match(h.replies[0].payload.text, /\.suara/);
    assert.equal(h.db.users['alice@s.whatsapp.net'].chat, 1);
    await h.api.stopBot();
});

test('failed reconnect schedules another attempt with increasing delay', async () => {
    let fail = false;
    const h = connectionHarness({ failFetch: () => fail });
    const sock = await h.api.startBot();
    sock.events.get('connection.update')({ connection: 'close' });
    assert.equal(sock.closed, true);
    assert.equal(h.timers[0].delay, 3000);
    fail = true; h.timers[0].fn(); await tick();
    assert.equal(h.timers[1].delay, 6000);
    fail = false; h.timers[1].fn(); await tick();
    assert.equal(h.sockets.length, 2);
    await h.api.stopBot();
});

test('updated image stack can convert a real image to a WebP sticker offline', async () => {
    const sharp = require('sharp');
    const input = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#00aa00' } }).png().toBuffer();
    const sticker = load('lib/features/sticker.js', { require(name) {
        if (name === '../core/jobs' || name === './jobs') return jobs;
        if (name === '../core/media') return { downloadBoundedMedia: async () => input };
        return require(name);
    } });
    const sent = [];
    await sticker.handleStickerImage({ async sendPresenceUpdate() {}, async sendMessage(to, payload) { sent.push(payload); } }, 'test', { message: { imageMessage: {} } });
    assert.equal(sent.length, 1);
    assert.equal((await sharp(sent[0].sticker).metadata()).format, 'webp');
});

test('real text sticker conversion works and cleans temporary files', async () => temporary(async dir => {
    const sticker = load('lib/features/sticker.js', {
        process: { cwd: () => dir },
        require(name) {
            if (name === '../core/jobs' || name === './jobs') return jobs;
            if (name === '../core/media') return {};
            return require(name);
        },
    });
    const sent = [];
    await sticker.handleStickerW({ async sendPresenceUpdate() {}, async sendMessage(to, payload) { sent.push(payload); } }, 'test', '.sticker halo');
    assert.equal(sent.length, 1);
    assert.ok(Buffer.isBuffer(sent[0].sticker), 'must produce sticker, not an error message');
    assert.equal((await require('sharp')(sent[0].sticker).metadata()).format, 'webp');
    assert.equal(fs.readdirSync(path.join(dir, 'temp')).length, 0);
}));

test('legacy histories without lastActive survive loading', async () => temporary(async dir => {
    fs.writeFileSync(path.join(dir, 'database.json'), JSON.stringify({ users: {
        legacy: { chat: 1, history: [{ role: 'user', content: 'keep' }] },
    } }));
    const db = database(dir).loadDatabase();
    assert.equal(db.users.legacy.history[0].content, 'keep');
    assert.ok(db.users.legacy.lastActive > 0);
}));

test('recovery skips a corrupt newest backup and uses an older valid snapshot', async () => temporary(async dir => {
    fs.mkdirSync(path.join(dir, 'backups'));
    fs.writeFileSync(path.join(dir, 'database.json'), '{bad');
    fs.writeFileSync(path.join(dir, 'backups/database-2000.json'), '{bad');
    fs.writeFileSync(path.join(dir, 'backups/database-1000.json'), JSON.stringify({ users: {}, limits: { heavy: [123] } }));
    const db = database(dir).loadDatabase();
    assert.equal(db.limits.heavy[0], 123);
}));
