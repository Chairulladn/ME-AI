const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");

const { loadDatabase, saveDatabase, getUser, incrementChat, updateUserName, checkOwner, checkDailyLimit, scheduleDatabaseSave, flushDatabase } = require("../core/database");
const { handleProblem, handleOff, handleRestart, handleStats, handleResetdb } = require("./commands");
const { handleAi } = require("../features/ai");
const { handleTts, sendVoiceAnswer } = require("../features/tts");
const { handleVoice } = require("../features/voice");
const { ensureTempDir, handleStickerW, handleStickerImage, handleStickerVid, handleStickerInfo } = require("../features/sticker");
const { checkLimit } = require("../core/rateLimiter");
const { JobQueue, guardedSocket, assertActive, abortable } = require("../core/jobs");
const { resolveSenderNumber } = require("./identity");
const pino = require("pino");
const { Agent } = require("undici");

// Command "berat" (biaya API / CPU) yang perlu dibatasi frekuensinya.
const HEAVY_COMMAND_LIMIT = { max: 6, windowMs: 60_000 };
let reconnectAttempt = 0;
let reconnectTimer;
let activeDb;
let activeSocket;
let stopping = false;
let starting;
let credentials = Promise.resolve();
const queue = new JobQueue({
    onError: error => console.error("[connection] gagal memproses pesan:", error.message),
    onTimeout: () => {
        const sock = activeSocket;
        if (sock) retireSocket(sock);
        scheduleReconnect();
    },
});
const seen = new Map();

async function allowHeavy(senderNumber, db) {
    for (const [key, limits] of [
        [senderNumber, HEAVY_COMMAND_LIMIT],
        ["global:minute", { max: 20, windowMs: 60000 }],
    ]) {
        const result = checkLimit(key, limits);
        if (!result.allowed) return result;
    }
    return checkDailyLimit(db);
}

function extractMessageText(msg) {
    return (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        null
    );
}

// Cocokkan command tanpa peduli huruf besar/kecil, dan tanpa spasi nyasar
// di ujung ("  .off  " tetap kena).
function isCommand(text, cmd) {
    return text.trim().toLowerCase() === cmd;
}

function startsWithCommand(text, prefix) {
    const value = text.trim().toLowerCase();
    const command = prefix.trim();
    return value === command || value.startsWith(`${command} `);
}

async function sendRateLimitNotice(sock, from, retryAfterMs) {
    const seconds = Math.ceil(retryAfterMs / 1000);
    await sock.sendMessage(from, {
        text: `⏳ pelan pelan lah, coba lagi dalam ${seconds} detik ya.`,
    });
}

async function handleIncomingMessage(sock, db, msg) {
    if (!msg.message) return;
    if (msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    if (!from || from === "status@broadcast" || from.endsWith("@g.us")) return;

    if (!from.endsWith("@s.whatsapp.net") && !from.endsWith("@lid")) return;

    const sender = msg.key.participant || msg.key.remoteJid;
    const senderNumber = await resolveSenderNumber(sock, msg);
    assertActive();
    const limitKey = senderNumber || sender;
    const pushName = msg.pushName || "Tanpa Nama";
    const isOwner = checkOwner(senderNumber);

    const admission = checkLimit(`incoming:${limitKey}`, { max: 20, windowMs: 60000 });
    if (!admission.allowed) return;
    if (!db.users[from] && Object.keys(db.users).length >= 10000) return;

    getUser(db, from);
    incrementChat(db, from);
    updateUserName(db, from, pushName);
    scheduleDatabaseSave(db);

    if (!db.users[from].greeted) {
        await sock.sendPresenceUpdate("composing", from);
        await new Promise((r) => setTimeout(r, 1500));
        await sock.sendMessage(from, { text: "Mohon tunggu ..." });
        if (!isOwner) {
            await sock.sendMessage(from, { text: "✨ Me - AI is Active ✨\nPesan AI, gambar, dan suara diproses layanan pihak ketiga. Ketik .privacy untuk detail." });
        }
        db.users[from].greeted = true;
        scheduleDatabaseSave(db);
    }

    if (isOwner && !db.users[from].ownerGreeted) {
        await sock.sendMessage(from, { text: "✨ Owner detected ✨" });
        db.users[from].ownerGreeted = true;
        scheduleDatabaseSave(db);
    }

    const text = extractMessageText(msg);
    const isImage = !!msg.message.imageMessage;

    if (msg.message.audioMessage) {
        const { allowed, retryAfterMs } = await allowHeavy(limitKey, db);
        if (!allowed) {
            await sendRateLimitNotice(sock, from, retryAfterMs);
            return;
        }
        return handleVoice(sock, from, msg, async (transcript) => {
            const reply = await handleAi(sock, from, `.ai ${transcript}`, false,
                msg, isOwner, db, saveDatabase, { voiceReply: true });
            await sendVoiceAnswer(sock, from, reply);
        });
    }
    if (!text) return;

    if (text.length > 4000) {
        await sock.sendMessage(from, { text: "Pesan maksimal 4000 karakter." });
        return;
    }

    if (isCommand(text, ".privacy")) {
        await sock.sendMessage(from, { text: "Privasi ME-AI: chat teks dan voice note diproses Groq; gambar diproses melalui OpenRouter; teks untuk suara diproses layanan Edge TTS. Riwayat teks/analisis gambar disimpan lokal. Ketik .forget untuk menghapus riwayat aktif; backup lama tetap ada sampai rotasi. Jangan kirim data rahasia yang tidak perlu." });
        return;
    }
    if (isCommand(text, ".forget")) {
        const previous = db.users[from].history;
        db.users[from].history = [];
        try { await saveDatabase(db); }
        catch (error) { assertActive(); db.users[from].history = previous; throw error; }
        await sock.sendMessage(from, { text: "Riwayat percakapan AI sudah dihapus." });
        return;
    }
    if (isCommand(text, ".problem")) return handleProblem(sock, from);
    if (isCommand(text, ".off")) return handleOff(sock, from, senderNumber);
    if (isCommand(text, ".restart")) return handleRestart(sock, from, senderNumber);
    if (isCommand(text, ".stats")) return handleStats(sock, from, senderNumber, db);
    if (isCommand(text, ".resetdb")) return handleResetdb(sock, from, senderNumber, saveDatabase, db);
    if (isCommand(text, ".stickers")) return handleStickerInfo(sock, from);

    // ---- Command "berat": dibatasi rate limit per nomor ----
    const isHeavyCommand =
    startsWithCommand(text, ".sticker ") ||
    (msg.message.imageMessage && isCommand(text, ".stickerimage")) ||
    (msg.message.videoMessage && isCommand(text, ".stickervid")) ||
    startsWithCommand(text, ".ai") ||
    startsWithCommand(text, ".suara");

    if (isHeavyCommand) {
        const { allowed, retryAfterMs } = await allowHeavy(limitKey, db);
        if (!allowed) {
            await sendRateLimitNotice(sock, from, retryAfterMs);
            return;
        }
    }

    if (startsWithCommand(text, ".sticker ")) return handleStickerW(sock, from, text);
    if (msg.message.imageMessage && isCommand(text, ".stickerimage")) return handleStickerImage(sock, from, msg);
    if (msg.message.videoMessage && isCommand(text, ".stickervid")) return handleStickerVid(sock, from, msg);
    if (startsWithCommand(text, ".ai")) {
        return handleAi(sock, from, text, isImage, msg, isOwner, db, saveDatabase);
    }
    if (/^\.suara(?:\s|$)/i.test(text.trim())) {
        return handleTts(sock, from, text);
    }

    if (isCommand(text, "/menu")) {
        await sock.sendPresenceUpdate("composing", from);

        const publicCommands = `👤 User Commands
➤ 🤖 .ai
Chat teks: .ai pertanyaan
Gambar: kirim dengan caption .ai jelaskan gambar ini

➤ 🔊 .suara teks
Ubah teks menjadi voice note

➤ 🎙️ Voice note
Kirim langsung untuk mendapat jawaban suara

➤ 🔐 .privacy
Lihat penggunaan data oleh layanan AI

➤ 🧹 .forget
Hapus riwayat chat AI

➤ 🎭 .stickers
Sticker features

➤ ⚠️ .problem
Report problem`;

        if (isOwner) {
            const ownerCommands = `🛠️ Owner Commands
➤ 🔴 .off
Shutdown bot

➤ 🔄 .restart
Restart bot

➤ 📊 .stats
Dashboard Bot

➤ 🗑️ .resetdb
Reset Database`;
            await sock.sendMessage(from, { text: `${publicCommands}\n\n${ownerCommands}` });
        } else {
            await sock.sendMessage(from, { text: publicCommands });
        }
        return;
    }

    await sock.sendMessage(from, { text: "ketik /menu untuk lihat semua command" });
}

function retireSocket(sock) {
    sock.ev.removeAllListeners("messages.upsert");
    sock.ev.removeAllListeners("connection.update");
    sock.ev.removeAllListeners("creds.update");
    if (activeSocket === sock) activeSocket = undefined;
    try { sock.end(new Error("Koneksi ditutup")); } catch (_) { /* already closed */ }
}

function scheduleReconnect() {
    if (stopping || reconnectTimer) return;
    const delay = Math.min(60000, 3000 * 2 ** Math.min(reconnectAttempt++, 5));
    console.log(`🔄 Reconnect dalam ${delay / 1000} detik...`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        startBot().catch(error => {
            console.error("[connection] reconnect gagal:", error.message);
            scheduleReconnect();
        });
    }, delay);
}

async function connect() {
    ensureTempDir();
    const db = activeDb || (activeDb = loadDatabase());
    // Normalize retention and create an initial backup before accepting messages.
    await saveDatabase(db);
    const { state, saveCreds } = await useMultiFileAuthState("./session");
    const dispatcher = new Agent({ headersTimeout: 15000, bodyTimeout: 15000, connect: { timeout: 10000 } });
    const signal = AbortSignal.timeout(15000);
    const abort = () => { void dispatcher.destroy(signal.reason).catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    let version;
    try {
        ({ version } = await abortable(() => fetchLatestBaileysVersion({ dispatcher }), signal));
    } finally {
        signal.removeEventListener("abort", abort);
        await dispatcher.destroy().catch(() => {});
    }
    if (stopping) return;
    const sock = makeWASocket({
        version, auth: state, printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        connectTimeoutMs: 30000, defaultQueryTimeoutMs: 30000,
    });
    activeSocket = sock;
    const safeSocket = guardedSocket(sock);
    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
        if (stopping || activeSocket !== sock) return;
        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log("Scan QR WhatsApp");
        }
        if (connection === "open") {
            reconnectAttempt = 0;
            console.log("Bot berhasil online ✅");
        }
        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            retireSocket(sock);
            if (reason === DisconnectReason.loggedOut) {
                console.log("Session logout. Tautkan ulang perangkat sebelum menjalankan bot kembali.");
                return;
            }
            scheduleReconnect();
        }
    });
    sock.ev.on("creds.update", () => {
        credentials = credentials.catch(() => {}).then(saveCreds);
        credentials.catch(error => console.error("[connection] gagal menyimpan sesi:", error.message));
    });
    sock.ev.on("messages.upsert", ({ messages, type }) => {
        if (type !== "notify" || stopping || activeSocket !== sock) return;
        for (const msg of messages || []) {
            if (!msg.message || msg.key?.fromMe) continue;
            const id = `${msg.key?.remoteJid}:${msg.key?.id}`;
            if (!msg.key?.id || seen.has(id)) continue;
            const accepted = queue.enqueue(async () => {
                if (activeSocket !== sock) { seen.delete(id); return; }
                try { await handleIncomingMessage(safeSocket, db, msg); }
                catch (error) {
                    assertActive();
                    await safeSocket.sendMessage(msg.key.remoteJid, {
                        text: "⚠️ Pemrosesan gagal. Perubahan belum dapat dipastikan tersimpan. Coba lagi nanti.",
                    });
                    throw error;
                }
            });
            if (!accepted) continue;
            seen.set(id, true);
            if (seen.size > 2000) seen.delete(seen.keys().next().value);
        }
    });
    return sock;
}
function startBot() {
    if (stopping) return Promise.resolve();
    if (starting) return starting;
    if (activeSocket) return Promise.resolve(activeSocket);
    starting = connect().finally(() => { starting = undefined; });
    return starting;
}
async function stopBot() {
    stopping = true;
    clearTimeout(reconnectTimer);
    await queue.stop();
    await flushDatabase();
    await credentials;
    if (activeSocket) retireSocket(activeSocket);
}
module.exports = { startBot, stopBot };
