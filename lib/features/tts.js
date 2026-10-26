const { getSignal, assertActive } = require('../core/jobs');
const { settings } = require('../../config/ai');
const { sendText } = require('../core/messages');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const execFileAsync = promisify(execFile);

async function handleTts(sock, from, text, options = {}) {
    const message = text.trim().replace(/^\.suara\b\s*/i, '').trim();
    if (!message || message.length > 500) {
        await sock.sendMessage(from, { text: message ? '⚠️ Teks suara maksimal 500 karakter.' : 'Contoh: .suara halo, ini ME-AI' });
        return false;
    }
    let tempDir;
    try {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meai-tts-'));
        const output = path.join(tempDir, 'suara.mp3');
        const voiceOutput = path.join(tempDir, 'suara.ogg');
        const binary = path.join(__dirname, '..', '..', '.venv-tts', 'bin', 'edge-tts');
        await execFileAsync(binary, ['--voice', settings().voice, '--text', message, '--write-media', output],
            { timeout: 45000, signal: getSignal(), killSignal: 'SIGKILL' });
        await execFileAsync('ffmpeg', ['-y', '-i', output, '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', voiceOutput],
            { timeout: 30000, signal: getSignal(), killSignal: 'SIGKILL' });
        assertActive();
        await sock.sendMessage(from, { audio: await fs.readFile(voiceOutput), mimetype: 'audio/ogg; codecs=opus', ptt: true });
        return true;
    } catch (error) {
        assertActive();
        console.error('[tts] proses gagal, kode:', error.code || error.name);
        if (!options.textAlreadySent) await sendText(sock, from, options.fallbackText || message);
        await sock.sendMessage(from, { text: '⚠️ Versi suara gagal dibuat/dikirim. Jawabannya tetap tersedia sebagai teks.' });
        return false;
    } finally {
        if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}
async function sendVoiceAnswer(sock, from, result) {
    if (!result) return;
    // Deliver the full answer before synthesis so an outage cannot lose it.
    await sendText(sock, from, result.text);
    if (result.speech) await handleTts(sock, from, `.suara ${result.speech}`, { textAlreadySent: true });
}
module.exports = { handleTts, sendVoiceAnswer };
