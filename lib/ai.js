const axios = require("axios");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const sharp = require("sharp");
const { pushHistory } = require("./database");

const REQUEST_TIMEOUT_MS = 30_000;

function buildSystemPrompt(isOwner, userName, { forImage } = {}) {
    return `Kamu adalah ME-AI buatan Chairul.

${isOwner ? "Yang chat sekarang adalah owner." : "Yang chat sekarang bukan owner."}

Nama user: ${userName || "Tanpa Nama"}

- Pakai gua dan lu.
- Santai kayak temen.
- Jangan baku.
- Jawab singkat.
${forImage ? '- Jangan mulai dengan "Tentu", "Baik", atau "Berikut penjelasannya".' : "- Kalau user bercanda, bercanda balik.\n- Kalau user ngomel, santai aja.\n- Kalau user serius, baru jelasin dengan jelas."}

Kamu dibuat oleh Chairul.
Jangan pernah mengaku dibuat oleh orang lain.`;
}

async function callVisionModel({ question, imageBuffer, isOwner, userName }) {
    if (!process.env.OPENROUTER_API_KEY) {
        throw new Error("OPENROUTER_API_KEY belum diset di .env");
    }
    const base64 = imageBuffer.toString("base64");
    return axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
            model: "openai/gpt-4.1-mini",
            messages: [
                { role: "system", content: buildSystemPrompt(isOwner, userName, { forImage: true }) },
                {
                    role: "user",
                    content: [
                        { type: "text", text: question || "Jelaskan gambar ini." },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
                    ],
                },
            ],
            max_tokens: 500,
        },
        {
            timeout: REQUEST_TIMEOUT_MS,
            headers: {
                Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
            },
        }
    );
}

async function callTextModel({ question, history, isOwner, userName }) {
    if (!process.env.GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY belum diset di .env");
    }
    return axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
            model: "openai/gpt-oss-120b",
            messages: [
                { role: "system", content: buildSystemPrompt(isOwner, userName) },
                ...(history || []),
                { role: "user", content: question },
            ],
            max_tokens: 800,
        },
        {
            timeout: REQUEST_TIMEOUT_MS,
            headers: {
                Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
                "Content-Type": "application/json",
            },
        }
    );
}

function extractText(aiMessageContent) {
    if (!aiMessageContent) return null;
    if (Array.isArray(aiMessageContent)) {
        return aiMessageContent.map((item) => item.text || "").join(" ").trim() || null;
    }
    return String(aiMessageContent).trim() || null;
}

async function handleAi(sock, from, text, isImage, msg, isOwner, db, saveDatabase, options = {}) {
    // Regex, bukan string.replace(".ai", "") -> ".ai apakah aikido bagus"
    // dulu ke-strip jadi rusak karena "ai" di tengah kalimat ikut kepotong.
    const question = text.replace(/^\.ai\b\s*/i, "").trim();

    if (!question && !isImage) {
        await sock.sendMessage(from, { text: "mau nanya apaan? Contoh: .ai berapa 1+1" });
        return;
    }

    await sock.sendPresenceUpdate("composing", from);

    let imageBuffer = null;
    if (isImage) {
        try {
            const raw = await downloadMediaMessage(msg, "buffer", {}, {
                logger: { info: () => {}, warn: () => {}, error: console.error },
                reuploadRequest: sock.updateMediaMessage,
            });
            imageBuffer = await sharp(raw)
                .resize({ width: 512, withoutEnlargement: true })
                .jpeg({ quality: 60 })
                .toBuffer();
        } catch (err) {
            console.error("[ai] gagal download/proses gambar:", err.message);
            await sock.sendMessage(from, { text: "⚠️ Gagal memproses gambarnya, coba kirim ulang." });
            return;
        }
    }

    const userName = db.users[from]?.name;
    let response;
    try {
        response = isImage
            ? await callVisionModel({ question, imageBuffer, isOwner, userName })
            : await callTextModel({ question, history: db.users[from]?.history, isOwner, userName });
    } catch (err) {
        const detail = err.response?.data?.error?.message || err.message;
        console.error("[ai] request gagal:", detail);
        await sock.sendMessage(from, {
            text: "⚠️ AI lagi bermasalah (server AI down / kuota habis / koneksi timeout). Coba lagi sebentar lagi.",
        });
        return;
    }

    const reply = extractText(response.data?.choices?.[0]?.message?.content)
        || "AI gagal mengambil jawaban akhir, coba kirim ulang.";

    if (!isImage) {
        pushHistory(db, from, "user", question);
        pushHistory(db, from, "assistant", reply);
        saveDatabase(db);
    }

    const usage = response.data?.usage;
    if (usage) {
        console.log(
            `[ai] model=${isImage ? "gpt-4.1-mini" : "gpt-oss-120b"} in=${usage.prompt_tokens ?? 0} out=${usage.completion_tokens ?? 0} total=${usage.total_tokens ?? 0}`
        );
    }

        if (options.voiceReply) {
        return reply;
    }

    await sock.sendMessage(from, { text: reply });
    return reply;
}

module.exports = {
    handleAi,
};
