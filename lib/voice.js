
const axios = require("axios");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const execFileAsync = promisify(execFile);

async function handleVoice(sock, from, msg, onTranscript) {
    let tempDir;

    try {
        await sock.sendPresenceUpdate("composing", from);

        if (!process.env.GROQ_API_KEY) {
            throw new Error("GROQ_API_KEY belum ada");
        }

        const audio = await downloadMediaMessage(
            msg,
            "buffer",
            {},
            { reuploadRequest: sock.updateMediaMessage }
        );

        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meai-vn-"));
        const input = path.join(tempDir, "voice.ogg");
        const output = path.join(tempDir, "voice.mp3");

        await fs.writeFile(input, audio);

        await execFileAsync("ffmpeg", [
            "-y", "-i", input,
            "-vn", "-ac", "1", "-ar", "16000",
            output
        ], { timeout: 30000 });

        const mp3 = await fs.readFile(output);

        // FormData dan Blob tersedia di Node.js 24.
        const form = new FormData();
        form.append(
            "file",
            new Blob([mp3], { type: "audio/mpeg" }),
            "voice.mp3"
        );
        form.append("model", "whisper-large-v3-turbo");
        form.append("language", "id");

        const result = await axios.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            form,
            {
                headers: {
                    Authorization: `Bearer ${process.env.GROQ_API_KEY}`
                },
                timeout: 60000
            }
        );

        const transcript = result.data?.text?.trim();

        if (!transcript) {
            await sock.sendMessage(from, {
                text: "⚠️ Suara belum berhasil dikenali."
            });
            return;
        }

        console.log("[voice] transkripsi berhasil");

        await onTranscript(transcript);

    } catch (err) {
        console.error(
            "[voice] error:",
            err.response?.data || err.message
        );

        await sock.sendMessage(from, {
            text: "⚠️ Gagal memahami voice note. Coba kirim ulang."
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

module.exports = { handleVoice };
