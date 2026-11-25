import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpeechProvider, createSpeechService, normalizePcmWav } from '../src/speech.js';
import { loadConfig } from '../src/config.js';

const principal = { issuer: 'https://issuer.example/', subject: 'alice' };
const record = { id: 1, title: 'historic title', note_title: 'secure', language: 'en' };
const base = { DATABASE_URL: 'postgresql://unused/test', PUBLIC_URL: 'https://memory.example',
  AUTH_ISSUER: 'https://issuer.example/', AUTH_AUDIENCE: 'memory', AUTH_JWKS_URL: 'https://issuer.example/jwks' };
export function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF'); bytes.writeUInt32LE(40, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(4, 40);
  return bytes;
}
const waveResponse = () => new Response(wav(), { headers: { 'Content-Type': 'audio/wav', 'Content-Length': '48' } });
const options = { provider: 'deepseek', apiKey: 'fixture-deepseek', voice: 'stella' };

test('completed PCM WAV streams get real RIFF/data lengths without changing audio samples', async () => {
  for (const riffSize of [40, 0x7ffffffe, 0x7fffffff, 0xfffffffe, 0xffffffff]) {
    for (const dataSize of [4, 0x7ffffffe, 0x7fffffff, 0xfffffffe, 0xffffffff]) {
      const source = wav();
      source.writeUInt32LE(riffSize, 4); source.writeUInt32LE(dataSize, 40);
      source.writeInt16LE(-32768, 44); source.writeInt16LE(32767, 46);
      const original = Buffer.from(source);
      const normalized = normalizePcmWav(source);
      assert.equal(normalized.readUInt32LE(4), normalized.length - 8);
      assert.equal(normalized.readUInt32LE(40), 4);
      assert.equal(normalized.readUInt32LE(40) / normalized.readUInt16LE(32), 2, 'duration uses actual PCM frames');
      assert.deepEqual(normalized.subarray(8, 40), source.subarray(8, 40));
      assert.deepEqual(normalized.subarray(44), source.subarray(44));
      assert.deepEqual(source, original, 'normalization cannot mutate an upstream-owned buffer');
    }
  }
  // The deployed DeepSeek sample has both 0xffffffff fields. Exercise the
  // provider boundary as well: normalization precedes caching/HTTP delivery.
  const streamed = wav(); streamed.writeUInt32LE(0xffffffff, 4); streamed.writeUInt32LE(0xffffffff, 40);
  const provider = createSpeechProvider({ ...options, fetchImpl: async () => new Response(streamed, {
    headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(streamed.length) },
  }) });
  assert.deepEqual((await provider({ text: 'fixture' })).bytes, wav());
});

test('WAV normalization walks bounded chunks instead of assuming fixed data offsets', () => {
  const chunk = (id, payload) => {
    const header = Buffer.alloc(8); header.write(id); header.writeUInt32LE(payload.length, 4);
    return Buffer.concat([header, payload, Buffer.alloc(payload.length % 2)]);
  };
  const fmt = Buffer.concat([wav().subarray(20, 36), Buffer.alloc(2)]);
  const leading = chunk('JUNK', Buffer.from([1, 2, 3]));
  const format = chunk('fmt ', fmt);
  const samples = Buffer.from([0, 128, 255, 127]);
  const header = Buffer.alloc(12); header.write('RIFF'); header.write('WAVE', 8);
  const streamedData = chunk('data', samples); streamedData.writeUInt32LE(0xffffffff, 4);
  const streamed = Buffer.concat([header, leading, format, streamedData]); streamed.writeUInt32LE(0xffffffff, 4);
  const normalized = normalizePcmWav(streamed);
  const dataSizeOffset = 12 + leading.length + format.length + 4;
  assert.equal(normalized.readUInt32LE(dataSizeOffset), samples.length);
  assert.equal(normalized.readUInt32LE(4), normalized.length - 8);
  assert.deepEqual(normalized.subarray(12, dataSizeOffset), streamed.subarray(12, dataSizeOffset));
  assert.deepEqual(normalized.subarray(dataSizeOffset + 4), samples);
  const finite = Buffer.concat([header, leading, format, chunk('data', samples), chunk('LIST', Buffer.from('INFO'))]);
  finite.writeUInt32LE(finite.length - 8, 4);
  assert.deepEqual(normalizePcmWav(finite), finite, 'finite metadata and RIFF padding remain intact');
});

test('finite WAV corruption and unsupported/incomplete PCM are rejected rather than repaired', () => {
  const cases = [];
  const changed = (offset, value, width = 4) => {
    const bytes = wav(); bytes[width === 2 ? 'writeUInt16LE' : 'writeUInt32LE'](value, offset); cases.push(bytes);
  };
  changed(4, 0); changed(4, 38); changed(4, 42); changed(4, 0xffffff00);
  changed(40, 0); changed(40, 2); changed(40, 3); changed(40, 6); changed(40, 0xffffff00);
  changed(16, 14); changed(16, 18); changed(16, 0xffffffff);
  changed(20, 3, 2); changed(22, 0, 2); changed(22, 3, 2);
  changed(24, 0); changed(28, 1); changed(32, 4, 2); changed(34, 8, 2);
  const noData = wav(); noData.write('JUNK', 36); cases.push(noData);
  const noFmt = wav(); noFmt.write('JUNK', 12); cases.push(noFmt);
  const oddStream = wav().subarray(0, 47); oddStream.writeUInt32LE(0xffffffff, 4); oddStream.writeUInt32LE(0xffffffff, 40); cases.push(oddStream);
  const partialTail = Buffer.concat([wav(), Buffer.from([1, 2])]); partialTail.writeUInt32LE(partialTail.length - 8, 4); cases.push(partialTail);
  const duplicateData = Buffer.concat([wav(), wav().subarray(36)]); duplicateData.writeUInt32LE(duplicateData.length - 8, 4); cases.push(duplicateData);
  const fmtAfterData = Buffer.concat([wav().subarray(0, 12), wav().subarray(36), wav().subarray(12, 36)]); cases.push(fmtAfterData);
  for (const bytes of cases) {
    assert.throws(() => normalizePcmWav(bytes), { code: 'speech_unavailable', status: 503 });
  }
  assert.throws(() => normalizePcmWav(wav(), 47), { code: 'speech_unavailable' });
});

test('speech is opt-in and DeepSeek never borrows another vendor credential', () => {
  const disabled = loadConfig({ ...base, DEEPSEEK_API_KEY: 'text-key' });
  assert.equal(disabled.speechProvider, 'disabled'); assert.equal(disabled.speechApiKey, null);
  const enabled = loadConfig({ ...base, SAYROVE_SPEECH_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'deepseek-key',
    SAYROVE_SPEECH_API_KEY: 'wrong-vendor-key' });
  assert.equal(enabled.speechApiKey, 'deepseek-key'); assert.equal(enabled.speechModel, null);
  assert.equal(enabled.speechVoice, 'stella'); assert.equal(enabled.speechBaseUrl, 'https://api.deepseek.com');
  const compatible = loadConfig({ ...base, SAYROVE_SPEECH_PROVIDER: 'openai-compatible',
    SAYROVE_SPEECH_BASE_URL: 'https://voice.example/v1', SAYROVE_SPEECH_MODEL: 'chosen-model', DEEPSEEK_API_KEY: 'wrong-vendor' });
  assert.equal(compatible.speechApiKey, null);
  assert.equal(createSpeechService({ provider: compatible.speechProvider, apiKey: compatible.speechApiKey,
    model: compatible.speechModel, voice: compatible.speechVoice, baseUrl: compatible.speechBaseUrl }).enabled, false);
  for (const value of ['http://voice.example', 'https://user:secret@voice.example', 'https://voice.example?key=secret'])
    assert.throws(() => loadConfig({ ...base, SAYROVE_SPEECH_BASE_URL: value }), (error) => !error.message.includes('secret'));
  assert.throws(() => loadConfig({ ...base, SAYROVE_SPEECH_PROVIDER: 'unknown' }), /registered provider/);
  assert.throws(() => loadConfig({ ...base, SAYROVE_SPEECH_PROVIDER: 'deepseek', SAYROVE_SPEECH_VOICE: 'unknown' }), /supported voice/);
  assert.throws(() => loadConfig({ ...base, SAYROVE_SPEECH_VOICE: 5 }), /supported voice/);
});

test('DeepSeek uses its documented WAV request, with only the current saved title', async () => {
  let request;
  const service = createSpeechService({ ...options, fetchImpl: async (url, init) => {
    request = { url, ...init }; return waveResponse();
  } });
  const result = await service.audio({ principal, record });
  assert.equal(request.url, 'https://api.deepseek.com/v1/tools/tts');
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers.Authorization, 'Bearer fixture-deepseek');
  assert.deepEqual(JSON.parse(request.body), { text: 'secure', voice_id: 'stella', format: 'wav', filter_markdown: true });
  assert.deepEqual(result.bytes, wav()); assert.equal(result.mimeType, 'audio/wav');
  service.close();
});

test('compatible provider keeps model and voice configurable and returns MP3', async () => {
  let request;
  const provider = createSpeechProvider({ provider: 'openai-compatible', apiKey: 'compatible-fixture',
    model: 'explicit-model', voice: 'explicit-voice', baseUrl: 'https://voice.example/v1/',
    fetchImpl: async (url, init) => { request = { url, ...init }; return new Response('ID3fixture', { headers: { 'Content-Type': 'audio/mpeg' } }); } });
  const result = await provider({ text: 'secure' });
  assert.equal(request.url, 'https://voice.example/v1/audio/speech');
  assert.deepEqual(JSON.parse(request.body), { model: 'explicit-model', input: 'secure', voice: 'explicit-voice', response_format: 'mp3' });
  assert.equal(result.mimeType, 'audio/mpeg');
});

test('cache and single-flight are tenant/config/text scoped, and edits invalidate audio', async () => {
  let resolve, calls = 0;
  const service = createSpeechService({ ...options, fetchImpl: async () => {
    calls++; if (calls === 1) await new Promise((done) => { resolve = done; }); return waveResponse();
  } });
  const first = service.audio({ principal, record });
  const second = service.audio({ principal, record });
  await new Promise(setImmediate); assert.equal(calls, 1); resolve();
  await Promise.all([first, second]);
  await service.audio({ principal, record }); assert.equal(calls, 1);
  await service.audio({ principal, record: { ...record, note_title: 'secure a job' } }); assert.equal(calls, 2);
  await service.audio({ principal: { ...principal, subject: 'bob' }, record }); assert.equal(calls, 3);
  await service.audio({ principal, record: { ...record, language: 'en-GB' } }); assert.equal(calls, 4);
  service.close();
});

test('bounded cache expiry and eviction require a new synthesis', async () => {
  let now = 0, calls = 0;
  const service = createSpeechService({ ...options, maxEntries: 1, ttlMs: 10, clock: () => now,
    fetchImpl: async () => { calls++; return waveResponse(); } });
  await service.audio({ principal, record });
  await service.audio({ principal, record: { ...record, note_title: 'another' } });
  await service.audio({ principal, record }); assert.equal(calls, 3);
  now = 11;
  await service.audio({ principal, record }); assert.equal(calls, 4);
  service.close();
});

test('voice requests have global/tenant/rate/deadline bounds and do not cache failures', async () => {
  let finish;
  const service = createSpeechService({ ...options, requestsPerMinute: 1, timeoutMs: 40, fetchImpl: async () => {
    await new Promise((resolve) => { finish = resolve; }); return waveResponse();
  } });
  const first = service.audio({ principal, record });
  await new Promise(setImmediate);
  await assert.rejects(service.audio({ principal, record: { ...record, note_title: 'different' } }), { code: 'speech_busy', status: 429 });
  await assert.rejects(first, { code: 'speech_unavailable', status: 503 });
  finish();
  await assert.rejects(service.audio({ principal, record }), { code: 'speech_busy', status: 429 });
  service.close();
  let release;
  const global = createSpeechService({ ...options, maxConcurrent: 1, fetchImpl: async () => {
    await new Promise((resolve) => { release = resolve; }); return waveResponse();
  } });
  const active = global.audio({ principal, record }); await new Promise(setImmediate);
  await assert.rejects(global.audio({ principal: { ...principal, subject: 'bob' }, record }), { code: 'speech_busy' });
  release(); await active; global.close();
});

test('aborting one waiter preserves another; aborting the final waiter cancels upstream', async () => {
  let release, upstream;
  const service = createSpeechService({ ...options, fetchImpl: async (_url, init) => {
    upstream = init.signal; await new Promise((resolve) => { release = resolve; }); return waveResponse();
  } });
  const a = new AbortController(), b = new AbortController();
  const first = service.audio({ principal, record, signal: a.signal });
  const second = service.audio({ principal, record, signal: b.signal });
  await new Promise(setImmediate); a.abort();
  await assert.rejects(first, { code: 'speech_cancelled' }); assert.equal(upstream.aborted, false);
  release(); await second;
  const c = new AbortController();
  const last = service.audio({ principal, record: { ...record, note_title: 'new text' }, signal: c.signal });
  await new Promise(setImmediate); c.abort();
  await assert.rejects(last, { code: 'speech_cancelled' }); assert.equal(upstream.aborted, true);
  service.close();
});

test('unsafe or unreadable content and malformed/truncated/oversized upstream audio fail safely', async () => {
  for (const record_ of [{ ...record, note_title: '' }, { ...record, note_title: 'x'.repeat(501) }, { ...record, language: 'fr' }]) {
    const service = createSpeechService({ ...options, fetchImpl: async () => { throw new Error('must not call'); } });
    await assert.rejects(service.audio({ principal, record: record_ }), error => error.status === 422);
  }
  const broken = wav(); broken.writeUInt32LE(1000, 4);
  const responses = [
    () => new Response('private-upstream-error', { status: 401 }),
    () => new Response('<html>secret</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response(broken, { headers: { 'Content-Type': 'audio/wav' } }),
    () => new Response(wav(), { headers: { 'Content-Type': 'audio/wav', 'Content-Length': '9999' } }),
  ];
  for (const response of responses) {
    const service = createSpeechService({ ...options, maxBytes: 1000, fetchImpl: async () => response() });
    await assert.rejects(service.audio({ principal, record }), error => error.code === 'speech_unavailable' && !error.message.includes('secret'));
    service.close();
  }
});
