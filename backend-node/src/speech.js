import { createHash } from 'node:crypto';

export class SpeechError extends Error {
  constructor(code = 'speech_unavailable', status = 503) { super(code); this.code = code; this.status = status; }
}

const MAX_TEXT = 500;
const AUDIO_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3']);
const DEEPSEEK_LANGUAGES = new Set(['zh', 'yue', 'en', 'ja', 'ko', 'ms', 'ar', 'id', 'th', 'vi']);

function endpoint(baseUrl, path) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('invalid_speech_configuration'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash)
    throw new Error('invalid_speech_configuration');
  return `${url.href.replace(/\/+$/, '')}/${path}`;
}

/** Providers receive only a bounded saved title, never arbitrary client text. */
export function createSpeechProvider({ provider, apiKey, model, voice, baseUrl, fetchImpl = fetch, maxBytes = 2 * 1024 * 1024 }) {
  if (provider === 'disabled' || !apiKey || (provider === 'openai-compatible' && !model)) return null;
  const deepseek = provider === 'deepseek';
  if (!deepseek && provider !== 'openai-compatible') throw new Error('invalid_speech_configuration');
  if (typeof apiKey !== 'string' || !apiKey.trim() || typeof voice !== 'string' || !voice.trim()
      || (!deepseek && (typeof model !== 'string' || !model.trim()))) throw new Error('invalid_speech_configuration');
  const url = endpoint(baseUrl ?? (deepseek ? 'https://api.deepseek.com' : ''), deepseek ? 'v1/tools/tts' : 'audio/speech');
  return async function synthesize({ text, signal }) {
    const body = deepseek ? { text, voice_id: voice, format: 'wav', filter_markdown: true }
      : { model, input: text, voice, response_format: 'mp3' };
    let response;
    try {
      response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' }, body: JSON.stringify(body) });
      if (!response.ok || response.redirected) throw new SpeechError();
      const type = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
      if (!AUDIO_TYPES.has(type) || (deepseek ? !['audio/wav', 'audio/x-wav'].includes(type) : !['audio/mpeg', 'audio/mp3'].includes(type)))
        throw new SpeechError();
      const declared = response.headers.get('content-length');
      if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new SpeechError();
      const chunks = [];
      let length = 0;
      if (!response.body) throw new SpeechError();
      for await (const chunk of response.body) {
        signal?.throwIfAborted();
        length += chunk.byteLength;
        if (length > maxBytes) throw new SpeechError();
        chunks.push(Buffer.from(chunk));
      }
      signal?.throwIfAborted();
      if (!length || (declared != null && Number(declared) !== length)) throw new SpeechError();
      const bytes = Buffer.concat(chunks);
      if (deepseek) {
        if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
          throw new SpeechError();
        // Streaming WAV can use an unknown RIFF size. Validate a finite size
        // when supplied, and never accept a known truncated response.
        const riffSize = bytes.readUInt32LE(4);
        if (riffSize > 0 && riffSize < 0xffffff00 && riffSize + 8 !== bytes.length) throw new SpeechError();
      } else if (!(bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) {
        throw new SpeechError();
      }
      return { bytes, mimeType: deepseek ? 'audio/wav' : 'audio/mpeg' };
    } catch {
      try { await response?.body?.cancel(); } catch { /* Reader may already be closed. */ }
      throw new SpeechError();
    }
  };
}

/** Bounded per-process cache and single-flight synthesis; callers still authorize each record. */
export function createSpeechService({ provider = 'disabled', apiKey = null, model = null, voice = 'stella', baseUrl,
  fetchImpl, maxBytes = 2 * 1024 * 1024, maxCacheBytes = 16 * 1024 * 1024, maxEntries = 64,
  timeoutMs = 15000, ttlMs = 24 * 60 * 60 * 1000, maxConcurrent = 2, requestsPerMinute = 30, clock = Date.now } = {}) {
  const synthesize = createSpeechProvider({ provider, apiKey, model, voice, baseUrl, fetchImpl, maxBytes });
  for (const number of [maxBytes, maxCacheBytes, maxEntries, timeoutMs, ttlMs, maxConcurrent, requestsPerMinute])
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('invalid_speech_configuration');
  const cache = new Map(), pending = new Map(), activeTenants = new Map(), limits = new Map();
  let cachedBytes = 0, active = 0;
  function evict(key) { const found = cache.get(key); if (found) { cachedBytes -= found.bytes.length; cache.delete(key); } }
  function cacheValue(key, value) {
    if (value.bytes.length > maxCacheBytes) return;
    while (cache.size >= maxEntries || cachedBytes + value.bytes.length > maxCacheBytes) evict(cache.keys().next().value);
    cache.set(key, { ...value, expires: clock() + ttlMs }); cachedBytes += value.bytes.length;
  }
  function wait(job, signal) {
    job.waiters++;
    return new Promise((resolve, reject) => {
      let finished = false;
      function settle(fn, value) {
        if (finished) return;
        finished = true; signal?.removeEventListener('abort', abort); job.waiters--;
        if (!job.waiters && !job.done) job.controller.abort();
        fn(value);
      }
      const abort = () => settle(reject, new SpeechError('speech_cancelled', 499));
      job.promise.then((value) => settle(resolve, value), (error) => settle(reject, error));
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  return {
    enabled: synthesize !== null,
    async audio({ principal, record, signal }) {
      if (!synthesize) throw new SpeechError();
      if (signal?.aborted) throw new SpeechError('speech_cancelled', 499);
      if (provider === 'deepseek' && !DEEPSEEK_LANGUAGES.has(record.language?.toLowerCase().split('-')[0]))
        throw new SpeechError('speech_language_unavailable', 422);
      const title = typeof record.note_title === 'string' ? record.note_title : record.title;
      if (typeof title !== 'string' || !title.trim() || [...title.trim()].length > MAX_TEXT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(title))
        throw new SpeechError('speech_text_unavailable', 422);
      const text = title.trim();
      const tenant = JSON.stringify([principal.issuer, principal.subject]);
      const key = createHash('sha256').update(JSON.stringify([tenant, provider, model, voice, baseUrl ?? null, record.language, text])).digest('hex');
      for (const [old, value] of cache) if (value.expires <= clock()) evict(old);
      const saved = cache.get(key);
      if (saved) { cache.delete(key); cache.set(key, saved); return { bytes: saved.bytes, mimeType: saved.mimeType }; }
      const existing = pending.get(key);
      if (existing && !existing.controller.signal.aborted) return wait(existing, signal);
      if (active >= maxConcurrent || activeTenants.has(tenant)) throw new SpeechError('speech_busy', 429);
      let limit = limits.get(tenant);
      if (!limit || limit.expires <= clock()) {
        if (limits.size >= 256) limits.delete(limits.keys().next().value);
        limit = { count: 0, expires: clock() + 60000 }; limits.set(tenant, limit);
      }
      if (limit.count >= requestsPerMinute) throw new SpeechError('speech_busy', 429);
      limit.count++;
      active++; activeTenants.set(tenant, true);
      const controller = new AbortController(), job = { controller, waiters: 0, done: false, promise: null };
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let abortJob;
      const expired = new Promise((_resolve, reject) => {
        abortJob = () => reject(new SpeechError());
        controller.signal.addEventListener('abort', abortJob, { once: true });
      });
      job.promise = Promise.race([Promise.resolve().then(() => synthesize({ text, signal: controller.signal })), expired]).then((value) => {
        controller.signal.throwIfAborted(); cacheValue(key, value); return value;
      }).catch(() => { throw new SpeechError(); }).finally(() => {
        job.done = true; clearTimeout(timer); controller.signal.removeEventListener('abort', abortJob);
        pending.delete(key); active--; activeTenants.delete(tenant);
      });
      pending.set(key, job);
      return wait(job, signal);
    },
    close() { for (const job of pending.values()) job.controller.abort(); cache.clear(); cachedBytes = 0; },
  };
}
