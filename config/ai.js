function integer(env, key, fallback, min, max) {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const number = Number(raw);
    if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${key} harus ${min}–${max}`);
    return number;
}
function bool(env, key, fallback) {
    if (env[key] === undefined || env[key] === '') return fallback;
    if (!['true', 'false'].includes(env[key])) throw new Error(`${key} harus true atau false`);
    return env[key] === 'true';
}
function settings(env = process.env) {
    return {
        textModel: env.AI_TEXT_MODEL || 'openai/gpt-oss-120b',
        visionModel: env.AI_VISION_MODEL || 'openai/gpt-4.1-mini',
        transcriptionModel: env.AI_TRANSCRIPTION_MODEL || 'whisper-large-v3-turbo',
        language: env.VOICE_LANGUAGE || 'id',
        transcriptionPrompt: (env.VOICE_TRANSCRIPTION_PROMPT || 'Percakapan bahasa Indonesia. Nama asisten ME-AI, dibuat oleh Chairul.').slice(0, 600),
        voice: env.TTS_VOICE || 'id-ID-ArdiNeural',
        retries: integer(env, 'AI_MAX_RETRIES', 1, 0, 2),
        textTokens: integer(env, 'AI_TEXT_MAX_TOKENS', 2048, 256, 4096),
        visionTokens: integer(env, 'AI_VISION_MAX_TOKENS', 1200, 256, 4096),
        imageDimension: integer(env, 'AI_IMAGE_MAX_DIMENSION', 2048, 512, 4096),
        zeroRetention: bool(env, 'OPENROUTER_ZDR', true),
    };
}
module.exports = { settings };
