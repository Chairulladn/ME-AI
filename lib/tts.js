
const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const execFileAsync = promisify(execFile);

async function handleTts(sock, from, text) {
    const message = text.replace(/^\.suara\b\s*/i, "").trim();

    if (!message) {
        return sock.sendMessage(from, {
            text: "Contoh: .suara halo bre, gw ME-AI"
        });
    }

    if (message.length > 500) {
        return sock.sendMessage(from, {
            text: "⚠️ Maksimal 500 karakter bre."
        });
    }

    let tempDir;

    try {
        tempDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "meai-tts-")
        );

        const output = path.join(tempDir, "suara.mp3");

        const ttsBinary = path.join(
            __dirname, "..", ".venv-tts", "bin", "edge-tts"
        );

        await execFileAsync(ttsBinary, [
            "--voice", "id-ID-ArdiNeural",
            "--text", message,
            "--write-media", output
        ], { timeout: 60000 });

        const voiceOutput = path.join(tempDir, "suara.ogg");

await execFileAsync("ffmpeg", [
    "-y",
    "-i", output,
    "-c:a", "libopus",
    "-b:a", "32k",
    "-ar", "48000",
    "-ac", "1",
    voiceOutput
], { timeout: 30000 });

const voiceAudio = await fs.readFile(voiceOutput);

await sock.sendMessage(from, {
    audio: voiceAudio,
    mimetype: "audio/ogg; codecs=opus",
    ptt: true
}); 

        console.log("[tts] berhasil membuat audio");
    } catch (err) {
        console.error("[tts] error:", err.message);

        await sock.sendMessage(from, {
            text: "⚠️ Gagal membuat suara AI."
        });
    } finally {
        if (tempDir) {
            await fs.rm(tempDir, {
                recursive: true,
                force: true
            }).catch(() => {});
        }
    }
}

module.exports = { handleTts };
