const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const { settings } = require('../config/ai');
const provider = require('../lib/core/provider');
const { sendText } = require('../lib/core/messages');
const { JobQueue } = require('../lib/core/jobs');
const root = path.resolve(__dirname, '..');

function feature(file, { env = {}, modules = {} } = {}) {
    const location = path.join(root, file);
    const actualRequire = createRequire(location);
    const environment = { GROQ_API_KEY: 'test-only', OPENROUTER_API_KEY: 'test-only', ...env };
    const context = {
        module: { exports: {} }, console, Buffer, FormData, Blob, __dirname: path.dirname(location),
        process: { env: environment },
        require(name) {
            if (Object.hasOwn(modules, name)) return modules[name];
            if (name === '../../config/ai') return { settings: () => settings(environment) };
            if (name === '../core/provider') return {
                ...provider,
                requestWithRetry: (fn, options) => provider.requestWithRetry(fn, { ...options, sleep: async () => {} }),
            };
            return actualRequire(name);
        },
    };
    vm.runInNewContext(fs.readFileSync(location, 'utf8'), context, { filename: location });
    return context.module.exports;
}
function response(content, finish = 'stop') {
    return { data: { choices: [{ message: { content }, finish_reason: finish }] } };
}
function socket() {
    const sent = [];
    return { sent, async sendMessage(to, payload) { sent.push(payload); }, async sendPresenceUpdate() {} };
}
function wav(duration = 1, amplitude = 10000) {
    const count = Math.floor(16000 * duration);
    const data = Buffer.alloc(44 + count * 2);
    data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVE', 8);
    data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
    data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
    data.write('data', 36); data.writeUInt32LE(count * 2, 40);
    for (let i = 0; i < count; i++) data.writeInt16LE(Math.round(amplitude * Math.sin(i * 0.15)), 44 + i * 2);
    return data;
}
function transcription(text = 'Halo ME-AI', quality = {}) {
    return { text, segments: [{ text, no_speech_prob: 0.01, avg_logprob: -0.1, compression_ratio: 1.2, ...quality }] };
}

// No test in this file sends an HTTP request or a WhatsApp message.
test('AI settings have safe defaults and reject invalid limits/privacy settings', () => {
    assert.equal(settings({}).zeroRetention, true);
    assert.equal(settings({}).voice, 'id-ID-ArdiNeural');
    assert.equal(settings({ AI_TEXT_MODEL: 'custom', TTS_VOICE: 'id-ID-GadisNeural' }).textModel, 'custom');
    assert.throws(() => settings({ AI_MAX_RETRIES: '100' }));
    assert.throws(() => settings({ OPENROUTER_ZDR: 'yes' }));
});

test('retry handles temporary failures, honors Retry-After and caps attempts', async () => {
    let calls = 0;
    const waits = [];
    const result = await provider.requestWithRetry(async () => {
        if (++calls === 1) throw { response: { status: 429, headers: { 'retry-after': '2' } } };
        return 'ok';
    }, { maxRetries: 1, sleep: async ms => waits.push(ms) });
    assert.equal(result, 'ok'); assert.equal(calls, 2); assert.deepEqual(waits, [2000]);
    calls = 0;
    await assert.rejects(provider.requestWithRetry(async () => {
        calls++; throw Object.assign(new Error('busy'), { response: { status: 503 } });
    }, { maxRetries: 1, sleep: async () => {} }));
    assert.equal(calls, 2);
});

test('billing, authentication, long Retry-After and ambiguous timeout are not replayed', async () => {
    for (const error of [
        { response: { status: 402 } }, { response: { status: 401 } },
        { response: { status: 429, data: { error: { code: 'insufficient_quota' } } } },
        { response: { status: 429, headers: { 'retry-after': '60' } } }, { code: 'ECONNABORTED' },
    ]) {
        let calls = 0;
        await assert.rejects(provider.requestWithRetry(async () => { calls++; throw error; }, { maxRetries: 2 }));
        assert.equal(calls, 1);
    }
    assert.match(provider.userError({ response: { status: 402 } }), /saldo/);
    assert.match(provider.userError({ response: { status: 401 } }), /Akses/);
    assert.match(provider.userError({ response: { status: 429 } }), /membatasi/);
});

test('retry wait can be cancelled by the job deadline', async () => {
    const errors = [];
    const queue = new JobQueue({ timeoutMs: 5, onError: e => errors.push(e) });
    let calls = 0;
    queue.enqueue(() => provider.requestWithRetry(async () => {
        calls++; throw { response: { status: 503 } };
    }));
    await queue.tail;
    assert.equal(calls, 1); assert.equal(errors.length, 1);
});

test('AI checks truncation and never speaks broken structured output', () => {
    const ai = feature('lib/features/ai.js');
    assert.match(ai.parseCompletion(response('Sebagian jawaban', 'length'), false).text, /terpotong/);
    const broken = ai.parseCompletion(response('{"answer":"belum selesai', 'length'), true);
    assert.equal(broken.speech, ''); assert.equal(broken.complete, false);
    const result = ai.parseCompletion(response(JSON.stringify({ answer: 'Jawaban lengkap.', speech: 'Versi singkat.' })), true);
    assert.equal(result.text, 'Jawaban lengkap.'); assert.equal(result.speech, 'Versi singkat.');
    assert.throws(() => ai.parseCompletion(response('internal', 'tool_calls'), false));
});

test('long voice summaries use whole sentences rather than cutting characters', () => {
    const { speechExcerpt } = feature('lib/features/ai.js');
    const excerpt = speechExcerpt('Kalimat pertama lengkap. ' + 'x'.repeat(1000));
    assert.equal(excerpt, 'Kalimat pertama lengkap. Detail selengkapnya ada di pesan teks.');
    assert.ok(speechExcerpt('x'.repeat(1000)).length <= 450);
});

test('full text delivery preserves long answers including emoji', async () => {
    const sock = socket();
    const text = 'Kalimat utuh. '.repeat(500) + '😃'.repeat(2000);
    await sendText(sock, 'test', text);
    assert.equal(sock.sent.map(p => p.text).join(''), text);
    assert.ok(sock.sent.every(p => p.text.length <= 3500));
});

test('voice answer requests one structured completion and stores only the full answer', async () => {
    let body;
    let saves = 0;
    const ai = feature('lib/features/ai.js', { modules: { axios: { async post(url, request) {
        body = request;
        return response(JSON.stringify({ answer: 'Penjelasan lengkap.', speech: 'Inti jawaban.' }));
    } } } });
    const db = { users: { test: { history: [], name: 'User' } } };
    const result = await ai.handleAi(socket(), 'test', '.ai halo', false, {}, false, db, async () => { saves++; }, { voiceReply: true });
    assert.equal(result.speech, 'Inti jawaban.');
    assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.include_reasoning, false);
    assert.equal(db.users.test.history[1].content, 'Penjelasan lengkap.');
    assert.equal(saves, 1);
});

test('images retain readable resolution, private routing and context for follow-up', async () => {
    const raw = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: 'white' } }).png().toBuffer();
    const calls = [];
    const ai = feature('lib/features/ai.js', { modules: {
        '../core/media': { downloadBoundedMedia: async () => raw },
        axios: { async post(url, body) { calls.push(body); return response('Pada gambar ada tulisan HALO.'); } },
    } });
    const image = await ai.prepareImage(raw);
    assert.equal((await sharp(image).metadata()).width, 2048);
    const db = { users: { test: { history: [] } } };
    const sock = socket();
    await ai.handleAi(sock, 'test', '.ai baca tulisannya', true, {}, false, db, async () => {});
    assert.equal(calls[0].provider.data_collection, 'deny');
    assert.equal(calls[0].provider.zdr, true);
    assert.equal(calls[0].provider.require_parameters, true);
    assert.equal(calls[0].messages.at(-1).content[1].image_url.detail, 'high');
    assert.ok(!JSON.stringify(db.users.test.history).includes('base64'));
    await ai.handleAi(sock, 'test', '.ai apa arti tulisan tadi?', false, {}, false, db, async () => {});
    assert.ok(calls[1].messages.some(m => m.content === 'Pada gambar ada tulisan HALO.'));
});

test('unavailable private image route never falls back to weaker privacy', async () => {
    let calls = 0;
    const raw = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'white' } }).png().toBuffer();
    const ai = feature('lib/features/ai.js', { modules: {
        '../core/media': { downloadBoundedMedia: async () => raw },
        axios: { async post(url, body) { calls++; assert.equal(body.provider.zdr, true); throw { response: { status: 404 } }; } },
    } });
    const sock = socket();
    await ai.handleAi(sock, 'test', '.ai lihat', true, {}, false, { users: { test: { history: [] } } }, async () => {});
    assert.equal(calls, 1); assert.match(sock.sent.at(-1).text, /privasi/);
});

test('WAV detection identifies silence and rejects uncertain/repetitive transcriptions', () => {
    const voice = feature('lib/features/voice.js');
    assert.equal(voice.audioStats(wav(1, 0)).activeDuration, 0);
    assert.ok(voice.audioStats(wav()).activeDuration > 0.9);
    assert.equal(voice.reliableTranscript(transcription()), 'Halo ME-AI');
    assert.equal(voice.reliableTranscript(transcription('musik', { no_speech_prob: 0.95 })), null);
    assert.equal(voice.reliableTranscript(transcription('acak', { avg_logprob: -2 })), null);
    assert.equal(voice.reliableTranscript(transcription('ulang', { compression_ratio: 5 })), null);
    assert.equal(voice.reliableTranscript({ text: 'tanpa metadata' }), null);
});

function voiceHarness(inputWav, data = transcription(), env = {}) {
    let uploads = 0;
    let form;
    const voice = feature('lib/features/voice.js', { env, modules: {
        '../core/media': { downloadBoundedMedia: async () => Buffer.from('fake input') },
        'node:child_process': { execFile(binary, args, options, callback) {
            fsp.writeFile(args.at(-1), inputWav).then(() => callback(null, '', ''), callback);
        } },
        axios: { async post(url, body) { uploads++; form = body; return { data }; } },
    } });
    return { voice, uploads: () => uploads, form: () => form };
}
test('silent and overlong audio is rejected before any paid transcription', async () => {
    for (const audio of [wav(1, 0), wav(120.1)]) {
        const h = voiceHarness(audio);
        let invoked = false;
        await h.voice.handleVoice(socket(), 'test', {}, async () => { invoked = true; });
        assert.equal(h.uploads(), 0); assert.equal(invoked, false);
    }
});

test('voice uploads WAV with quality metadata and respects language/model settings', async () => {
    const h = voiceHarness(wav(), transcription(), { VOICE_LANGUAGE: 'auto', AI_TRANSCRIPTION_MODEL: 'whisper-large-v3' });
    let text;
    await h.voice.handleVoice(socket(), 'test', {}, async transcript => { text = transcript; });
    assert.equal(text, 'Halo ME-AI');
    assert.equal(h.form().get('file').type, 'audio/wav');
    assert.equal(h.form().get('response_format'), 'verbose_json');
    assert.equal(h.form().get('language'), null);
    assert.equal(h.form().get('model'), 'whisper-large-v3');
});

test('unclear speech never invokes AI and downstream failures are not mislabeled', async () => {
    const uncertain = voiceHarness(wav(), transcription('musik', { no_speech_prob: 0.95 }));
    let invoked = false;
    await uncertain.voice.handleVoice(socket(), 'test', {}, async () => { invoked = true; });
    assert.equal(invoked, false);
    const good = voiceHarness(wav());
    const sock = socket();
    await assert.rejects(good.voice.handleVoice(sock, 'test', {}, async () => { throw new Error('AI failure'); }), /AI failure/);
    assert.equal(sock.sent.length, 0);
});

test('real FFmpeg conversion generates the WAV layout used by silence detection', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'meai-wav-test-'));
    try {
        const file = path.join(dir, 'test.wav');
        execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', file], { stdio: 'ignore' });
        const stats = feature('lib/features/voice.js').audioStats(await fsp.readFile(file));
        assert.equal(stats.duration, 1); assert.ok(stats.activeDuration > 0.9);
    } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('failed TTS retains full text once and never slices the voice answer', async () => {
    const commands = [];
    const sock = socket();
    const tts = feature('lib/features/tts.js', { modules: {
        'node:child_process': { execFile(binary, args, options, callback) {
            commands.push(args);
            assert.equal(sock.sent[0].text, 'Jawaban lengkap yang sudah terkirim.');
            callback(Object.assign(new Error('offline'), { code: 'ENOENT' }));
        } },
    } });
    await tts.sendVoiceAnswer(sock, 'test', { text: 'Jawaban lengkap yang sudah terkirim.', speech: 'Ringkasan utuh.' });
    assert.equal(commands[0][commands[0].indexOf('--text') + 1], 'Ringkasan utuh.');
    assert.equal(sock.sent.filter(p => p.text === 'Jawaban lengkap yang sudah terkirim.').length, 1);
    assert.match(sock.sent.at(-1).text, /tetap tersedia/);
});

test('direct suara command falls back to text if synthesis fails', async () => {
    const tts = feature('lib/features/tts.js', { modules: {
        'node:child_process': { execFile(binary, args, options, callback) { callback(new Error('offline')); } },
    } });
    const sock = socket();
    assert.equal(await tts.handleTts(sock, 'test', '.suara halo dunia'), false);
    assert.equal(sock.sent[0].text, 'halo dunia');
});

test('successful TTS uses configured voice and produces an actual Opus voice note offline', async () => {
    let selectedVoice;
    let workingDir;
    const realExecFile = require('node:child_process').execFile;
    const tts = feature('lib/features/tts.js', { env: { TTS_VOICE: 'id-ID-GadisNeural' }, modules: {
        'node:child_process': { execFile(binary, args, options, callback) {
            if (binary.endsWith('edge-tts')) {
                selectedVoice = args[args.indexOf('--voice') + 1];
                const output = args[args.indexOf('--write-media') + 1];
                workingDir = path.dirname(output);
                return realExecFile('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', output], options, callback);
            }
            return realExecFile(binary, args, options, callback);
        } },
    } });
    const sock = socket();
    assert.equal(await tts.handleTts(sock, 'test', '.suara halo'), true);
    assert.equal(selectedVoice, 'id-ID-GadisNeural');
    assert.equal(sock.sent[0].audio.toString('ascii', 0, 4), 'OggS');
    assert.ok(sock.sent[0].audio.includes(Buffer.from('OpusHead')));
    assert.equal(sock.sent[0].ptt, true);
    assert.equal(fs.existsSync(workingDir), false);
});
