const { createCanvas } = require("@napi-rs/canvas");
const sharp = require("sharp");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const path = require("path");

// FIX: sebelumnya path.resolve(__dirname, "temp") -> ini nunjuk ke lib/temp,
// sedangkan index.js bikin folder terpisah di root ./temp yang nggak
// kepakai sama sekali. Sekarang disatukan ke satu folder: <root>/temp.
function getTempDir() {
    return path.join(process.cwd(), "temp");
}

function ensureTempDir() {
    const tempDir = getTempDir();
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    return tempDir;
}

function parseColor(text) {
    const lower = text.toLowerCase();
    let color = "#000000";
    let bgColor = "#FFFFFF";
    let textContent = text;

    if (lower.includes("-r") || lower.includes("red")) {
        color = "#FF0000";
        textContent = text.replace(/\s*-[rR]\s*/, " ").replace(/\s*red\s*/gi, " ");
    } else if (lower.includes("-b") || lower.includes("blue")) {
        color = "#0066FF";
        textContent = text.replace(/\s*-[bB]\s*/, " ").replace(/\s*blue\s*/gi, " ");
    } else if (lower.includes("-g") || lower.includes("green")) {
        color = "#00CC00";
        textContent = text.replace(/\s*-[gG]\s*/, " ").replace(/\s*green\s*/gi, " ");
    } else if (lower.includes("-y") || lower.includes("yellow")) {
        color = "#FFCC00";
        bgColor = "#000000";
        textContent = text.replace(/\s*-[yY]\s*/, " ").replace(/\s*yellow\s*/gi, " ");
    } else if (lower.includes("-p") || lower.includes("pink")) {
        color = "#FF69B4";
        textContent = text.replace(/\s*-[pP]\s*/, " ").replace(/\s*pink\s*/gi, " ");
    } else if (lower.includes("-v") || lower.includes("purple") || lower.includes("violet")) {
        color = "#9932CC";
        textContent = text.replace(/\s*-[vV]\s*/, " ").replace(/\s*(purple|violet)\s*/gi, " ");
    } else if (lower.includes("-o") || lower.includes("orange")) {
        color = "#FF8C00";
        textContent = text.replace(/\s*-[oO]\s*/, " ").replace(/\s*orange\s*/gi, " ");
    }

    textContent = textContent.replace(/\s*-[a-zA-Z]+\s*/g, " ").trim();
    return { text: textContent, color, bgColor };
}

function wrapText(ctx, text, maxWidth) {
    const words = text.split(" ");
    const lines = [];
    let currentLine = "";
    for (const word of words) {
        const testLine = currentLine ? currentLine + " " + word : word;
        const metrics = ctx.measureText(testLine);
        if (metrics.width > maxWidth && currentLine) {
            lines.push(currentLine);
            currentLine = word;
        } else {
            currentLine = testLine;
        }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
}

function hexToRgb(hex) {
    const num = parseInt(hex.replace("#", ""), 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

// Gaya "brat": background warna polos (nggak gradasi/border kayak dulu),
// teks tebal huruf kecil semua, dan pinggiran tulisannya di-blur dikit
// biar keliatan agak "smudge" -- ciri khas meme brat itu.
//
// Cara kerjanya 2 lapis:
// 1. Gambar teksnya doang di kanvas transparan.
// 2. Blur lapisan teks itu pake sharp (background nggak ikut buram).
// 3. Tempel lapisan teks yang udah blur di atas background warna polos.
async function renderBratFrame({ revealedText, color, bgColor, fontSize }) {
    const canvas = createCanvas(512, 512);
    const ctx = canvas.getContext("2d");
    ctx.font = `${fontSize}px Arial`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;

    const lines = wrapText(ctx, revealedText, 440);
    const lineHeight = fontSize + 14;
    const startY = 85;

    ctx.save();

ctx.scale(0.68, 1);

for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], 59, startY + i * lineHeight);
}

ctx.restore();

    const textLayer = canvas.toBuffer("image/png");
    const blurredText = revealedText ? await sharp(textLayer).blur(3).toBuffer() : textLayer;

    const { r, g, b } = hexToRgb(bgColor);
    return sharp({
        create: { width: 512, height: 512, channels: 4, background: { r, g, b, alpha: 1 } },
    })
        .composite([{ input: blurredText }])
        .png()
        .toBuffer();
}

function cleanupFrames(framesDir) {
    try {
        if (fs.existsSync(framesDir)) {
            fs.rmSync(framesDir, { recursive: true, force: true });
        }
    } catch (e) {
        console.error("[sticker] cleanup error:", e.message);
    }
}

function buildConcatList(framesDir, frameFiles) {
    const concatListPath = path.join(framesDir, "concat_list.txt");
    const concatContent = frameFiles
        .map((f) => `file '${path.join(framesDir, f).replace(/\\/g, "/")}'`)
        .join("\n");
    fs.writeFileSync(concatListPath, concatContent);
    return concatListPath;
}

async function handleStickerW(sock, from, text) {
    await sock.sendPresenceUpdate("composing", from);

    const rawText = text.replace(/^\.sticker\s*/i, "");
    const { text: textContentRaw, color, bgColor } = parseColor(rawText);

    // Ala "brat": semua huruf kecil.
    const textContent = textContentRaw.toLowerCase();
    const words = textContent.split(/\s+/).filter(Boolean);

    const tempBase = ensureTempDir();
    const timestamp = Date.now();
    const framesDir = path.join(tempBase, `frames_${timestamp}`);
    const outputVideo = path.join(tempBase, `${timestamp}_anim.webm`);

    fs.mkdirSync(framesDir, { recursive: true });

    const fps = 24;
    const fontSize = 168;

    // Timing kemunculan kata satu per satu (bukan fade semua sekaligus):
    // - initialDelayMs: jeda sebelum kata pertama muncul
    // - perWordMs: jarak waktu antar kata muncul
    // - holdAfterMs: teks lengkap "diam" sebentar sebelum stiker loop lagi
    const initialDelayMs = 250;
    const holdAfterMs = 900;
    const maxDurationMs = 8000; // biar teks kepanjangan nggak bikin video kelamaan
    let perWordMs = 450;

    let totalDurationMs = initialDelayMs + perWordMs * words.length + holdAfterMs;
    if (totalDurationMs > maxDurationMs) {
        totalDurationMs = maxDurationMs;
        perWordMs = Math.max(150, (maxDurationMs - initialDelayMs - holdAfterMs) / words.length);
    }

    const totalFrames = Math.ceil((totalDurationMs / 1000) * fps);

    try {
        for (let frame = 0; frame < totalFrames; frame++) {
            const frameTime = (frame / fps) * 1000;

            let revealedCount = 0;
            if (frameTime >= initialDelayMs) {
                revealedCount = Math.floor((frameTime - initialDelayMs) / perWordMs) + 1;
            }
            revealedCount = Math.min(revealedCount, words.length);
            const revealedText = words.slice(0, revealedCount).join(" ");

            const frameBuffer = await renderBratFrame({ revealedText, color, bgColor, fontSize });
            const framePath = path.join(framesDir, `frame_${String(frame).padStart(5, "0")}.png`);
            fs.writeFileSync(framePath, frameBuffer);
        }
    } catch (err) {
        console.error("[sticker] gagal render frame:", err.message);
        await sock.sendMessage(from, { text: "Gagal membuat sticker animasi (render gagal)." });
        cleanupFrames(framesDir);
        return;
    }

    const frameFiles = fs.readdirSync(framesDir)
        .filter((f) => f.startsWith("frame_") && f.endsWith(".png"))
        .sort();

    if (frameFiles.length === 0) {
        await sock.sendMessage(from, { text: "Gagal membuat sticker animasi (tidak ada frame)." });
        cleanupFrames(framesDir);
        return;
    }

    return new Promise((resolve) => {
    ffmpeg()
        .input(path.join(framesDir, "frame_%05d.png"))
        .inputOptions([
            "-framerate", String(fps),
        ])
        .outputOptions([
            "-c:v", "libwebp",
            "-lossless", "0",
            "-q:v", "70",
            "-loop", "0",
            "-vf", "scale=320:320:force_original_aspect_ratio=increase,crop=320:320,fps=28",
            "-an",
        ])
        .format("webp")
        .save(outputVideo)
        .on("end", async () => {
            try {
                if (!fs.existsSync(outputVideo) || fs.statSync(outputVideo).size < 1000) {
                    await sock.sendMessage(from, {
                        text: "Gagal membuat sticker animasi (output kosong).",
                    });
                    return;
                }

                const sticker = fs.readFileSync(outputVideo);
                await sock.sendMessage(from, { sticker });

            } catch (err) {
                console.error("[sticker] gagal kirim animated WebP:", err.message);
                await sock.sendMessage(from, {
                    text: "Gagal membuat sticker animasi.",
                });
            } finally {
                cleanupFrames(framesDir);

                if (fs.existsSync(outputVideo)) {
                    fs.unlinkSync(outputVideo);
                }

                resolve();
            }
        })
        .on("error", async (err, stdout, stderr) => {
            console.error("[sticker] ffmpeg error:", err.message);
            if (stderr) console.error(stderr);

            await sock.sendMessage(from, {
                text: "Gagal membuat sticker animasi.",
            });

            cleanupFrames(framesDir);

            if (fs.existsSync(outputVideo)) {
                fs.unlinkSync(outputVideo);
            }

            resolve();
        });
});
}

async function handleStickerImage(sock, from, msg) {
    await sock.sendPresenceUpdate("composing", from);

    try {
        const buffer = await downloadMediaMessage(msg, "buffer", {}, {
            logger: { info: () => {}, warn: () => {}, error: console.error },
        });
        const sticker = await sharp(buffer)
            .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp()
            .toBuffer();

        await sock.sendMessage(from, { sticker });
    } catch (err) {
        console.error("[sticker] handleStickerImage error:", err.message);
        await sock.sendMessage(from, { text: "Gagal membuat sticker." });
    }
}

async function handleStickerVid(sock, from, msg) {
    await sock.sendPresenceUpdate("composing", from);

    const tempBase = ensureTempDir();
    const timestamp = Date.now();
    const inputPath = path.join(tempBase, `${timestamp}.mp4`);
    const outputPath = path.join(tempBase, `${timestamp}.webp`);

    try {
        const buffer = await downloadMediaMessage(msg, "buffer", {}, {
            logger: { info: () => {}, warn: () => {}, error: console.error },
            reuploadRequest: sock.updateMediaMessage,
        });
        fs.writeFileSync(inputPath, buffer);
    } catch (err) {
        console.error("[sticker] gagal download video:", err.message);
        await sock.sendMessage(from, { text: "Gagal mengunduh videonya, coba kirim ulang." });
        return;
    }

    await new Promise((resolve) => {
        ffmpeg(inputPath)
            .outputOptions([
                "-c:v", "libwebp",
                "-vf", "scale=320:320:force_original_aspect_ratio=increase,crop=320:320,fps=28",
                "-loop", "0",
                "-ss", "0",
                "-t", "5",
                "-preset", "default",
                "-an",
            ])
            .save(outputPath)
            .on("end", async () => {
                try {
                    const sticker = fs.readFileSync(outputPath);
                    await sock.sendMessage(from, { sticker });
                } catch (err) {
                    console.error("[sticker] gagal kirim hasil convert:", err.message);
                    await sock.sendMessage(from, { text: "Gagal membuat sticker dari video." });
                } finally {
                    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                    resolve();
                }
            })
            .on("error", async (err) => {
                console.error("[sticker] ffmpeg error:", err.message);
                await sock.sendMessage(from, { text: "Gagal convert video." });
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                resolve();
            });
    });
}

async function handleStickerInfo(sock, from) {
    await sock.sendPresenceUpdate("composing", from);
    await sock.sendMessage(from, {
        text: `➤ 🎥 .stickervid [dari video]
➤ 🖼️ .stickerimage [dari gambar]
➤ 🎭 .sticker [dari teks]

Contoh: .sticker info mabar`,
    });
}

module.exports = {
    ensureTempDir,
    handleStickerW,
    handleStickerImage,
    handleStickerVid,
    handleStickerInfo,
};
