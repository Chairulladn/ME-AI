const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const moment = require("moment");
const { Boom } = require("@hapi/boom");

const { loadDatabase, saveDatabase, getUser, incrementChat, updateUserName, checkOwner } = require("./database");
const { handleProblem, handleOff, handleRestart, handleStats, handleResetdb } = require("./commands");
const { handleAi } = require("./ai");
const { handleTts } = require("./tts");
const { handleVoice } = require("./voice");
const { ensureTempDir, handleStickerW, handleStickerImage, handleStickerVid, handleStickerInfo } = require("./sticker");
const { checkLimit } = require("./rateLimiter");

// Command "berat" (biaya API / CPU) yang perlu dibatasi frekuensinya.
const HEAVY_COMMAND_LIMIT = { max: 6, windowMs: 60_000 };

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
    return text.trim().toLowerCase().startsWith(prefix);
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

    const sender = msg.key.participant || msg.key.remoteJid;
    const senderNumber = sender.split("@")[0];
    const pushName = msg.pushName || "Tanpa Nama";
    const isOwner = checkOwner(senderNumber);

    getUser(db, from);
    incrementChat(db, from);
    updateUserName(db, from, pushName);
    saveDatabase(db);

    if (!db.users[from].greeted) {
        await sock.sendPresenceUpdate("composing", from);
        await new Promise((r) => setTimeout(r, 1500));
        await sock.sendMessage(from, { text: "Mohon tunggu ..." });
        if (!isOwner) {
            await sock.sendMessage(from, { text: "✨ Me - AI is Active ✨" });
        }
        db.users[from].greeted = true;
        saveDatabase(db);
    }

    if (isOwner && !db.users[from].ownerGreeted) {
        await sock.sendMessage(from, { text: "✨ Owner detected ✨" });
        db.users[from].ownerGreeted = true;
        saveDatabase(db);
    }

    const text = extractMessageText(msg);
const isImage = !!msg.message.imageMessage;

// Voice note WhatsApp
if (msg.message.audioMessage) {
    if (!isOwner) {
        const { allowed, retryAfterMs } = checkLimit(
            senderNumber,
            HEAVY_COMMAND_LIMIT
        );

        if (!allowed) {
            await sendRateLimitNotice(sock, from, retryAfterMs);
            return;
        }
    }

    return handleVoice(sock, from, msg, async (transcript) => {
    console.log("[voice-chat] VN diterima");

    const reply = await handleAi(
        sock,
        from,
        `.ai ${transcript}`,
        false,
        msg,
        isOwner,
        db,
        saveDatabase,
        { voiceReply: true }
    );

    if (!reply) {
        console.log("[voice-chat] AI tidak menghasilkan jawaban");
        return;
    }

    console.log("[voice-chat] AI berhasil menjawab");

    await handleTts(
    sock,
    from,
    `.suara ${reply.slice(0, 300)}`
);
});
}

if (!text) return;

    console.log(`[${moment().format("HH:mm:ss")}] ${senderNumber}: ${text}`);

    if (isCommand(text, ".problem")) return handleProblem(sock, from);
    if (isCommand(text, ".off")) return handleOff(sock, from, senderNumber);
    if (isCommand(text, ".restart")) return handleRestart(sock, from, senderNumber);
    if (isCommand(text, ".stats")) return handleStats(sock, from, senderNumber, db);
    if (isCommand(text, ".resetdb")) return handleResetdb(sock, from, senderNumber, saveDatabase);
    if (isCommand(text, ".stickers")) return handleStickerInfo(sock, from);

    // ---- Command "berat": dibatasi rate limit per nomor ----
    const isHeavyCommand =
    startsWithCommand(text, ".sticker ") ||
    (msg.message.imageMessage && isCommand(text, ".stickerimage")) ||
    (msg.message.videoMessage && isCommand(text, ".stickervid")) ||
    startsWithCommand(text, ".ai") ||
    startsWithCommand(text, ".suara");

    if (isHeavyCommand && !isOwner) {
        const { allowed, retryAfterMs } = checkLimit(senderNumber, HEAVY_COMMAND_LIMIT);
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
Chat with Me - AI

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

async function startBot() {
    ensureTempDir();
    const db = loadDatabase();

    const { state, saveCreds } = await useMultiFileAuthState("./session");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
    });

    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log("Scan QR WhatsApp");
        }

        if (connection === "open") {
            console.log("Bot berhasil online ✅");
        }

        if (connection === "close") {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

            if (reason === DisconnectReason.loggedOut) {
                console.log("Session Logout ❌ — hapus folder session lalu login ulang.");
                return;
            }

            console.log("🔄 Reconnect dalam 3 detik...");
            setTimeout(() => startBot(), 3000);
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        try {
            await handleIncomingMessage(sock, db, msg);
        } catch (err) {
            // Jaga-jaga: satu pesan error nggak boleh bikin seluruh bot crash.
            console.error("[connection] error saat proses pesan:", err);
            try {
                if (msg?.key?.remoteJid) {
                    await sock.sendMessage(msg.key.remoteJid, {
                        text: "⚠️ lagi ada error di sistem. Coba lagi nanti.",
                    });
                }
            } catch (_) { /* kalau kirim notif error pun gagal, ya sudah */ }
        }
    });

    return sock;
}

module.exports = { startBot };
