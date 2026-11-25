import test from "node:test";
import assert from "node:assert/strict";
import { PronunciationController, MAX_AUDIO_BYTES } from "../web/pronunciation.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const audioResponse = (type = "audio/wav") => new Response(new Uint8Array([0, 128, 255, 42]), {
  headers: { "Content-Type": type },
});
function fixture(options = {}) {
  const audio = [], states = [], errors = [], urls = [], revoked = [], requests = [];
  const controller = new PronunciationController({
    createAudioContext: () => null,
    requestAudio: async (id) => { requests.push(id); return audioResponse(); },
    onState: (state) => states.push(state), onError: (error) => errors.push(error.message),
    createObjectURL: (blob) => { urls.push(blob); return "blob:test/" + urls.length; },
    revokeObjectURL: (url) => revoked.push(url),
    createAudio: (url) => {
      const listeners = new Map();
      const player = {
        url, pauses: 0, loads: 0, removed: [],
        async play() {}, pause() { ++this.pauses; }, load() { ++this.loads; },
        removeAttribute(name) { this.removed.push(name); },
        addEventListener(name, callback) { listeners.set(name, callback); },
        removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name); },
        emit(name) { listeners.get(name)?.(); },
      };
      audio.push(player);
      return player;
    }, ...options,
  });
  return { controller, audio, states, errors, urls, revoked, requests };
}

test("backend audio plays from a Blob and end releases the only playback URL", async () => {
  for (const type of ["audio/wav", "audio/mpeg; codec=mp3"]) {
    const f = fixture({ requestAudio: async () => audioResponse(type) });
    await f.controller.toggle(7);
    assert.deepEqual(f.states, [{ recordId: 7, phase: "loading" }, { recordId: 7, phase: "playing" }]);
    assert.equal(f.urls[0].type, type.split(";")[0]);
    assert.deepEqual([...new Uint8Array(await f.urls[0].arrayBuffer())], [0, 128, 255, 42]);
    assert.equal(f.audio[0].url, "blob:test/1");
    f.audio[0].emit("ended");
    assert.equal(f.controller.current, null);
    assert.deepEqual(f.revoked, ["blob:test/1"]);
    assert.equal(f.audio[0].pauses, 1);
    assert.deepEqual(f.audio[0].removed, ["src"]);
    assert.equal(f.audio[0].loads, 1);
    f.audio[0].emit("ended");
    assert.equal(f.revoked.length, 1);
    assert.deepEqual(f.errors, []);
  }
});

function webAudioFixture(contextOptions = {}, controllerOptions = {}) {
  const sources = [], decoded = [], events = [];
  let contexts = 0, resumes = 0;
  const context = {
    state: "suspended", destination: {},
    async resume() { ++resumes; events.push("resume"); this.state = "running"; },
    async decodeAudioData(bytes) { events.push("decode"); decoded.push([...new Uint8Array(bytes)]); return { duration: 0.2 }; },
    createBufferSource() {
      const source = {
        starts: 0, stops: 0, disconnects: 0,
        connect(destination) { assert.equal(destination, context.destination); },
        start() { ++this.starts; events.push("start"); },
        stop() { ++this.stops; }, disconnect() { ++this.disconnects; },
        finish() { this.onended?.(); },
      };
      sources.push(source);
      return source;
    }, ...contextOptions,
  };
  const f = fixture({ createAudioContext: () => { ++contexts; events.push("create-context"); return context; }, ...controllerOptions });
  const request = f.controller.requestAudio;
  f.controller.requestAudio = (id) => { events.push("request"); return request(id); };
  return { ...f, context, sources, decoded, events, contexts: () => contexts, resumes: () => resumes };
}

test("Web Audio creates and resumes synchronously before fetching, decodes bytes and reuses one context", async () => {
  const f = webAudioFixture();
  const first = f.controller.toggle(7);
  assert.deepEqual(f.events, ["create-context", "resume", "request"], "activation happens before the first await");
  await first;
  assert.deepEqual(f.decoded, [[0, 128, 255, 42]]);
  assert.equal(f.sources[0].starts, 1);
  assert.equal(f.audio.length, 0, "Web Audio does not need a media element or CSP media URL");
  assert.equal(f.urls.length, 0);
  assert.deepEqual(f.states.at(-1), { recordId: 7, phase: "playing" });
  f.sources[0].finish();
  assert.equal(f.sources[0].disconnects, 1);
  assert.equal(f.controller.current, null);
  await f.controller.toggle(8);
  assert.equal(f.contexts(), 1);
  assert.equal(f.resumes(), 1, "a running context already has user activation");
  f.controller.stop();
  assert.equal(f.sources[1].stops, 1);
  assert.equal(f.sources[1].disconnects, 1);
});

test("a delayed Web Audio decoder cannot start a stale or canceled record", async () => {
  const pending = deferred();
  let decodes = 0;
  const f = webAudioFixture({ decodeAudioData: () => ++decodes === 1 ? pending.promise : Promise.resolve({ duration: 0.2 }) });
  const first = f.controller.toggle(7);
  await tick();
  await f.controller.toggle(8);
  pending.resolve({ duration: 0.2 });
  await first;
  assert.equal(f.sources.length, 1);
  assert.equal(f.controller.current.recordId, 8);
  assert.equal(f.sources[0].starts, 1);
  f.controller.stop();
  assert.equal(f.sources[0].stops, 1);
  assert.deepEqual(f.errors, []);
});

test("autoplay rejection retains decoded audio and retries with a synchronous gesture without refetching", async () => {
  let resumes = 0;
  const f = webAudioFixture({ resume() {
    if (++resumes === 1) return Promise.reject(new DOMException("private policy detail", "NotAllowedError"));
    this.state = "running";
    return Promise.resolve();
  } });
  await f.controller.toggle(7);
  assert.equal(f.controller.current.phase, "ready");
  assert.equal(f.sources.length, 0);
  assert.deepEqual(f.errors, ["speechTapToPlay"]);
  assert.deepEqual(f.controller.lastDiagnostic, { stage: "context", engine: "web-audio", errorName: "NotAllowedError" });
  const retry = f.controller.toggle(7);
  assert.equal(resumes, 2, "the retry resumes synchronously within the second click");
  await retry;
  assert.deepEqual(f.requests, [7]);
  assert.equal(f.decoded.length, 1);
  assert.equal(f.sources[0].starts, 1);
  assert.equal(f.controller.current.phase, "playing");
  f.controller.stop();
});

test("a suspended context with a non-settling resume becomes ready instead of hanging", async () => {
  const f = webAudioFixture({ resume: () => new Promise(() => {}) }, { resumeTimeoutMs: 5 });
  await f.controller.toggle(7);
  assert.equal(f.controller.current.phase, "ready");
  assert.deepEqual(f.errors, ["speechTapToPlay"]);
  assert.equal(f.sources.length, 0);
  f.controller.stop();
});

test("stopping while context resume is pending completes without starting a source", async () => {
  const f = webAudioFixture({ resume: () => new Promise(() => {}) });
  const playing = f.controller.toggle(7);
  await tick();
  f.controller.stop();
  await playing;
  assert.equal(f.sources.length, 0);
  assert.deepEqual(f.errors, []);
});

test("account invalidation during Web Audio decoding discards the buffer", async () => {
  let active = true;
  const pending = deferred();
  const f = webAudioFixture({ decodeAudioData: () => pending.promise }, { canPlay: () => active });
  const playing = f.controller.toggle(7);
  await tick();
  active = false;
  f.controller.stop();
  pending.resolve({ duration: 0.2 });
  await playing;
  assert.equal(f.sources.length, 0);
  assert.equal(f.controller.current, null);
  assert.deepEqual(f.errors, []);
});

test("diagnostics distinguish decoder failure and never include private errors, payloads or audio URLs", async () => {
  const diagnostics = [];
  const f = webAudioFixture({ decodeAudioData: async () => {
    throw new DOMException("private URL https://secret.example/audio and bytes", "EncodingError");
  } }, { onDiagnostic: (event) => diagnostics.push(event) });
  await f.controller.toggle(7);
  assert.deepEqual(f.controller.lastDiagnostic, { stage: "decode", engine: "web-audio", errorName: "EncodingError" });
  assert.deepEqual(f.errors, ["speechUnavailable"]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private|https:|bytes|recordId|blob:|data:/);
  assert.equal(f.controller.current, null);
});

test("media fallback keeps a blocked loaded element and synchronously replays it on the next click", async () => {
  const f = fixture();
  let plays = 0;
  const create = f.controller.createAudio;
  f.controller.createAudio = (url) => {
    const audio = create(url);
    audio.play = () => ++plays === 1 ? Promise.reject(new DOMException("", "NotAllowedError")) : Promise.resolve();
    return audio;
  };
  await f.controller.toggle(7);
  assert.equal(f.controller.current.phase, "ready");
  assert.deepEqual(f.errors, ["speechTapToPlay"]);
  assert.deepEqual(f.revoked, []);
  const retry = f.controller.toggle(7);
  assert.equal(plays, 2, "loaded media.play is called before retry's first await");
  await retry;
  assert.deepEqual(f.requests, [7]);
  assert.equal(f.audio.length, 1);
  assert.deepEqual(f.states.at(-1), { recordId: 7, phase: "playing" });
  f.controller.stop();
  assert.deepEqual(f.revoked, ["blob:test/1"]);
});

test("media diagnostics retain only the numeric MediaError code and standard error name", async () => {
  const f = fixture();
  await f.controller.toggle(7);
  f.audio[0].error = { code: 4, message: "private codec URL" };
  f.audio[0].emit("error");
  assert.deepEqual(f.controller.lastDiagnostic, { stage: "media", engine: "media", errorName: "Error", mediaCode: 4 });
  assert.deepEqual(f.errors, ["speechUnavailable"]);
});

test("native MCP audio uses bounded data media allowed by the host default CSP", async () => {
  const f = fixture({ sourceMode: "data" });
  await f.controller.toggle(7);
  assert.equal(f.audio[0].url, "data:audio/wav;base64,AID/Kg==");
  const [prefix, encoded] = f.audio[0].url.split(",");
  assert.equal(prefix, "data:audio/wav;base64");
  assert.deepEqual([...Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))], [0, 128, 255, 42]);
  assert.equal(f.urls.length, 0);
  f.audio[0].emit("ended");
  assert.equal(f.audio[0].pauses, 1);
  assert.deepEqual(f.audio[0].removed, ["src"]);
  assert.equal(f.audio[0].loads, 1);
  assert.deepEqual(f.revoked, []);
  assert.equal(f.controller.current, null);
  assert.deepEqual(f.errors, []);
});

test("stopping or switching during native data encoding cannot play stale audio", async () => {
  const pending = deferred();
  let conversions = 0;
  const f = fixture({ sourceMode: "data", createDataURL: async () => {
    ++conversions;
    return conversions === 1 ? pending.promise : "data:audio/wav;base64,AID/Kg==";
  } });
  const first = f.controller.toggle(7);
  await tick();
  assert.equal(conversions, 1);
  await f.controller.toggle(8);
  pending.resolve("data:audio/wav;base64,AID/Kg==");
  await first;
  assert.equal(f.audio.length, 1);
  assert.equal(f.controller.current.recordId, 8);
  f.controller.stop();
  assert.deepEqual(f.revoked, []);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.states, [
    { recordId: 7, phase: "loading" }, null,
    { recordId: 8, phase: "loading" }, { recordId: 8, phase: "playing" }, null,
  ]);
});

test("clicking the same pending pronunciation stops it and ignores its late response", async () => {
  const pending = deferred();
  const f = fixture({ requestAudio: () => pending.promise });
  const first = f.controller.toggle(7);
  await f.controller.toggle(7);
  pending.resolve(audioResponse());
  await first;
  assert.deepEqual(f.states, [{ recordId: 7, phase: "loading" }, null]);
  assert.equal(f.audio.length, 0);
  assert.equal(f.urls.length, 0);
  assert.deepEqual(f.errors, []);
});

test("switching records stops the previous audio and never plays an older pending request", async () => {
  const pending = deferred();
  const f = fixture({ requestAudio: (id) => id === 1 ? pending.promise : Promise.resolve(audioResponse()) });
  const old = f.controller.toggle(1);
  await f.controller.toggle(2);
  pending.resolve(audioResponse());
  await old;
  assert.equal(f.audio.length, 1);
  assert.equal(f.controller.current.recordId, 2);
  await f.controller.toggle(3);
  assert.equal(f.audio[0].pauses, 1);
  assert.deepEqual(f.revoked, ["blob:test/1"]);
  f.controller.stop(2);
  assert.equal(f.controller.current.recordId, 3, "an old record removal cannot stop the new record");
  f.controller.stop(3);
  assert.deepEqual(f.revoked, ["blob:test/1", "blob:test/2"]);
});

test("account invalidation cancels an in-progress body and prevents delayed playback", async () => {
  let active = true, cancelCount = 0;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
    cancel() { ++cancelCount; },
  });
  const f = fixture({ canPlay: () => active, requestAudio: async () => new Response(body, {
    headers: { "Content-Type": "audio/wav" },
  }) });
  const playing = f.controller.toggle(7);
  await tick();
  active = false;
  f.controller.stop();
  await playing;
  assert.equal(cancelCount, 1);
  assert.equal(f.audio.length, 0);
  assert.deepEqual(f.errors, []);
  await f.controller.toggle(8);
  assert.equal(f.states.length, 2, "a blocked account does not start another request");
});

test("revoked account state also blocks playback if it changes before the caller stops the controller", async () => {
  let active = true;
  const pending = deferred();
  const f = fixture({ canPlay: () => active, requestAudio: () => pending.promise });
  const playing = f.controller.toggle(7);
  active = false;
  pending.resolve(audioResponse());
  await playing;
  assert.equal(f.audio.length, 0);
  assert.equal(f.controller.current, null);
  assert.deepEqual(f.errors, []);
});

test("a stopped HTMLAudio play promise cannot revive playback or report a stale error", async () => {
  const playing = deferred();
  const f = fixture();
  const baseCreate = f.controller.createAudio;
  f.controller.createAudio = (url) => {
    const player = baseCreate(url);
    player.play = () => playing.promise;
    return player;
  };
  const old = f.controller.toggle(7);
  await tick();
  f.controller.stop();
  playing.reject(new Error("Playback was interrupted"));
  await old;
  assert.deepEqual(f.revoked, ["blob:test/1"]);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.states, [{ recordId: 7, phase: "loading" }, null]);
});

test("backend speech errors use localized keys without retrying or falling back to a system voice", async () => {
  for (const [status, code, expected] of [
    [503, "speech_unavailable", "speechUnavailable"], [429, "speech_busy", "speechBusy"],
    [422, "speech_language_unavailable", "speechLanguageUnavailable"],
    [409, "account_changed", "account_changed"], [403, "cloud_not_connected", "cloud_not_connected"],
    [404, "unknown_private_detail", "notFound"], [502, "private_provider_error", "speechUnavailable"],
  ]) {
    let calls = 0;
    const f = fixture({ requestAudio: async () => { ++calls; return Response.json({ error: code }, { status }); } });
    await f.controller.toggle(7);
    assert.deepEqual(f.errors, [expected]);
    assert.equal(calls, 1);
    assert.equal(f.audio.length, 0);
  }
});

test("audio limits reject unsupported MIME, empty bodies and both declared and streamed oversize content", async () => {
  const responses = [
    new Response("<script>private</script>", { headers: { "Content-Type": "text/html" } }),
    new Response(new Uint8Array(), { headers: { "Content-Type": "audio/wav" } }),
    new Response(new Uint8Array([1]), { headers: { "Content-Type": "audio/wav", "Content-Length": String(MAX_AUDIO_BYTES + 1) } }),
    new Response(new Uint8Array(MAX_AUDIO_BYTES + 1), { headers: { "Content-Type": "audio/mpeg" } }),
  ];
  for (const response of responses) {
    const f = fixture({ requestAudio: async () => response });
    await f.controller.toggle(7);
    assert.deepEqual(f.errors, ["speechUnavailable"]);
    assert.equal(f.urls.length, 0);
    assert.equal(f.audio.length, 0);
  }
});

test("media playback failures release the URL and show a generic pronunciation error", async () => {
  const f = fixture();
  const baseCreate = f.controller.createAudio;
  f.controller.createAudio = (url) => {
    const player = baseCreate(url);
    player.play = async () => { throw new Error("private media implementation error"); };
    return player;
  };
  await f.controller.toggle(7);
  assert.deepEqual(f.errors, ["speechUnavailable"]);
  assert.deepEqual(f.revoked, ["blob:test/1"]);
  assert.equal(f.controller.current, null);
  const after = fixture();
  await after.controller.toggle(7);
  after.audio[0].emit("error");
  assert.deepEqual(after.errors, ["speechUnavailable"]);
  assert.deepEqual(after.revoked, ["blob:test/1"]);
});
