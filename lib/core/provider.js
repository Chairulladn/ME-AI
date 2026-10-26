const { setTimeout: delay } = require('node:timers/promises');
const { getSignal, assertActive } = require('./jobs');

function kind(error) {
    const status = error.response?.status;
    const code = String(error.response?.data?.error?.code || '').toLowerCase();
    if (status === 402 || /quota|billing|credit|budget/.test(code)) return 'quota';
    if (status === 401 || status === 403) return 'access';
    if (status === 429) return 'rate';
    if (status === 404) return 'configuration';
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return 'timeout';
    if (status >= 500) return 'temporary';
    if (['EAI_AGAIN', 'ECONNREFUSED'].includes(error.code)) return 'temporary';
    return 'other';
}
function retryDelay(error, attempt, now = Date.now()) {
    const header = error.response?.headers?.['retry-after'];
    if (header !== undefined) {
        const seconds = Number(header);
        const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
        if (Number.isFinite(ms)) return Math.max(0, ms);
    }
    return Math.min(2000, 500 * 2 ** attempt) + Math.floor(Math.random() * 100);
}
async function requestWithRetry(request, { maxRetries = 1, sleep = delay } = {}) {
    for (let attempt = 0; ; attempt++) {
        assertActive();
        try { return await request(); }
        catch (error) {
            assertActive();
            if (error.code === 'ERR_CANCELED' || error.name === 'AbortError') throw error;
            // Do not replay invalid keys, billing errors, malformed requests, or
            // ambiguous client timeouts that may already have incurred a charge.
            const retryable = ['rate', 'temporary'].includes(kind(error));
            const ms = retryDelay(error, attempt);
            if (!retryable || attempt >= maxRetries || ms > 5000) throw error;
            await sleep(ms, undefined, { signal: getSignal() });
        }
    }
}
function userError(error, feature = 'AI') {
    switch (kind(error)) {
        case 'quota': return `⚠️ Kuota/saldo layanan ${feature} tidak mencukupi. Pemilik bot perlu memeriksanya.`;
        case 'access': return `⚠️ Akses layanan ${feature} ditolak. Pemilik bot perlu memeriksa kunci dan izin API.`;
        case 'rate': return `⏳ Layanan ${feature} sedang membatasi permintaan. Coba lagi nanti.`;
        case 'configuration': return `⚠️ Model atau penyedia ${feature} tidak tersedia. Pemilik bot perlu memeriksa pengaturan model dan privasi.`;
        case 'timeout': return `⚠️ Layanan ${feature} terlalu lama merespons. Coba lagi nanti.`;
        default: return `⚠️ Layanan ${feature} sedang bermasalah. Coba lagi nanti.`;
    }
}
module.exports = { requestWithRetry, userError, kind, retryDelay };
