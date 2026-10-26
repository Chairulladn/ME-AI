const { getSignal, assertActive } = require('../core/jobs');
const { settings } = require('../../config/ai');
const { requestWithRetry, userError } = require('../core/provider');
const axios = require('axios');
const { downloadBoundedMedia } = require('../core/media');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const execFileAsync = promisify(execFile);

function audioStats(wav) {
    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('WAV tidak valid');
    let offset = 12;
    let pcm;
    let format;
    while (offset + 8 <= wav.length) {
        const id = wav.toString('ascii', offset, offset + 4);
        const size = wav.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (size > wav.length - start) throw new Error('WAV terpotong');
        if (id === 'fmt ' && size >= 16) format = { codec: wav.readUInt16LE(start), channels: wav.readUInt16LE(start + 2), rate: wav.readUInt32LE(start + 4), bits: wav.readUInt16LE(start + 14) };
        if (id === 'data') pcm = wav.subarray(start, start + size);
        offset = start + size + (size % 2);
    }
    if (!format || format.codec !== 1 || format.channels !== 1 || format.rate !== 16000 || format.bits !== 16 || !pcm) throw new Error('Format audio tidak didukung');
    const samples = Math.floor(pcm.length / 2);
    let activeSamples = 0;
    for (let start = 0; start < samples; start += 320) {
        const count = Math.min(320, samples - start);
        let energy = 0;
        for (let i = 0; i < count; i++) energy += (pcm.readInt16LE((start + i) * 2) / 32768) ** 2;
        const db = 10 * Math.log10(energy / count || 1e-12);
        if (db > -45) activeSamples += count;
    }
    return { duration: samples / 16000, activeDuration: activeSamples / 16000 };
}
function reliableTranscript(data) {
    if (!Array.isArray(data?.segments)) return null;
    const accepted = data.segments.filter(segment => {
        if (typeof segment.text !== 'string' || !segment.text.trim()) return false;
        // Metadata must be present; missing confidence is not a reliable result.
        return Number.isFinite(segment.no_speech_prob) && segment.no_speech_prob <= 0.6
            && Number.isFinite(segment.avg_logprob) && segment.avg_logprob >= -1
            && (!Number.isFinite(segment.compression_ratio) || segment.compression_ratio <= 2.4);
    });
    const text = accepted.map(segment => segment.text.trim()).join(' ').trim();
    return text && text.length <= 4000 ? text : null;
}
async function handleVoice(sock, from, msg, onTranscript) {
    const config = settings();
    let tempDir;
    let transcript;
    try {
        if (!process.env.GROQ_API_KEY) {
            await sock.sendMessage(from, { text: '⚠️ Layanan transkripsi belum dikonfigurasi pemilik bot.' });
            return;
        }
        await sock.sendPresenceUpdate('composing', from);
        const audio = await downloadBoundedMedia(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meai-vn-'));
        const input = path.join(tempDir, 'voice.ogg');
        const output = path.join(tempDir, 'voice.wav');
        await fs.writeFile(input, audio);
        await execFileAsync('ffmpeg', [
            '-y', '-i', input, '-t', '121', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output,
        ], { timeout: 30000, signal: getSignal(), killSignal: 'SIGKILL' });
        const wav = await fs.readFile(output);
        const stats = audioStats(wav);
        if (stats.duration > 120) {
            await sock.sendMessage(from, { text: '⚠️ Voice note maksimal 120 detik. Kirim dalam beberapa bagian.' });
            return;
        }
        if (stats.duration < 0.25 || stats.activeDuration < 0.15) {
            await sock.sendMessage(from, { text: '🎙️ Suaranya terlalu sunyi atau pendek. Coba rekam ulang lebih dekat ke mikrofon.' });
            return;
        }
        const result = await requestWithRetry(() => {
            // Rebuild multipart body for every permitted retry.
            const form = new FormData();
            form.append('file', new Blob([wav], { type: 'audio/wav' }), 'voice.wav');
            form.append('model', config.transcriptionModel);
            form.append('response_format', 'verbose_json');
            if (config.language !== 'auto') form.append('language', config.language);
            form.append('prompt', config.transcriptionPrompt);
            return axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
                headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 30000, signal: getSignal(),
            });
        }, { maxRetries: config.retries });
        assertActive();
        transcript = reliableTranscript(result.data);
        if (!transcript) {
            await sock.sendMessage(from, { text: '🎙️ Percakapannya belum cukup jelas. Coba rekam ulang tanpa musik atau suara latar yang keras.' });
            return;
        }
    } catch (error) {
        assertActive();
        console.error('[voice] gagal, kode:', error.response?.status || error.code || error.name);
        await sock.sendMessage(from, { text: userError(error, 'transkripsi') });
        return;
    } finally {
        if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    // Downstream AI/TTS errors must not be mislabeled as failed transcription.
    assertActive();
    await onTranscript(transcript);
}
module.exports = { handleVoice, audioStats, reliableTranscript };
