const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Agent } = require('undici');
const { getSignal, abortable } = require('./jobs');
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 120;

async function downloadBoundedMedia(msg, type, options = {}, context = {}) {
    const media = msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.audioMessage;
    if (!media) throw new Error('Media tidak didukung');
    if (Number(media.fileLength || 0) > MAX_MEDIA_BYTES) throw new Error('Media maksimal 10 MB');
    if (msg.message.audioMessage && Number(media.seconds || 0) > MAX_AUDIO_SECONDS) {
        throw new Error('Audio maksimal 120 detik');
    }
    const local = new AbortController();
    const parent = getSignal();
    const signal = parent ? AbortSignal.any([parent, local.signal]) : local.signal;
    // A dedicated dispatcher lets us destroy even a request waiting for headers.
    const dispatcher = new Agent({ headersTimeout: 30000, bodyTimeout: 30000, connect: { timeout: 10000 } });
    let stream;
    const abort = () => {
        stream?.destroy(signal.reason);
        void dispatcher.destroy(signal.reason).catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => local.abort(new Error('Media download timeout')), 30000);
    try {
        const pending = downloadMediaMessage(msg, 'stream', {
            ...options, options: { ...options.options, dispatcher },
        }, { logger: { info() {}, warn() {}, error() {}, debug() {} }, ...context });
        pending.then((value) => { if (signal.aborted) value.destroy(); }, () => {});
        stream = await abortable(() => pending, signal);
        const chunks = [];
        let bytes = 0;
        for await (const chunk of stream) {
            signal.throwIfAborted();
            bytes += chunk.length;
            if (bytes > MAX_MEDIA_BYTES) throw new Error('Media maksimal 10 MB');
            chunks.push(chunk);
        }
        return Buffer.concat(chunks, bytes);
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        stream?.destroy();
        await dispatcher.destroy().catch(() => {});
    }
}
module.exports = { downloadBoundedMedia };
