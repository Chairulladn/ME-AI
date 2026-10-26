// Rate limiter sederhana berbasis sliding window, per-key (biasanya per nomor).
// Nggak butuh dependency luar, cukup buat bot single-instance.
//
// Kenapa ini penting: tanpa ini, orang bisa spam ".ai" atau ".stickervid"
// terus-terusan dan bikin kuota Groq/OpenRouter jebol dalam hitungan menit,
// atau bikin CPU kewalahan render sticker animasi berkali-kali.

const buckets = new Map();

/**
 * @param {string} key - identitas pemanggil, misal nomor sender
 * @param {object} opts
 * @param {number} opts.max - jumlah maksimum request dalam window
 * @param {number} opts.windowMs - panjang window dalam ms
 * @returns {{ allowed: boolean, retryAfterMs: number }}
 */
function checkLimit(key, { max = 5, windowMs = 60_000 } = {}) {
    const now = Date.now();
    const timestamps = (buckets.get(key)?.timestamps || []).filter((t) => now - t < windowMs);

    if (timestamps.length >= max) {
        const oldest = timestamps[0];
        const retryAfterMs = windowMs - (now - oldest);
        buckets.set(key, { timestamps, windowMs });
        return { allowed: false, retryAfterMs };
    }

    timestamps.push(now);
    buckets.set(key, { timestamps, windowMs });
    return { allowed: true, retryAfterMs: 0 };
}

// Bersih-bersih berkala biar Map nggak numpuk key lama selamanya.
setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets.entries()) {
        const fresh = bucket.timestamps.filter((t) => now - t < bucket.windowMs);
        if (fresh.length === 0) buckets.delete(key);
        else buckets.set(key, { ...bucket, timestamps: fresh });
    }
}, 5 * 60_000).unref();

module.exports = { checkLimit };
