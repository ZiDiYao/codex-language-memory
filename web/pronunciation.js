export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const audioTypes = new Set(["audio/wav", "audio/mpeg"]);

export function audioMimeType(value) {
  const type = typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
  if (!audioTypes.has(type)) throw new Error("speechUnavailable");
  return type;
}

async function audioBlob(response, operation) {
  let type;
  try { type = audioMimeType(response.headers.get("Content-Type")); }
  catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (declaredLength > MAX_AUDIO_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("speechUnavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("speechUnavailable");
  operation.reader = reader;
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AUDIO_BYTES) throw new Error("speechUnavailable");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { delete operation.reader; reader.releaseLock(); }
  if (!size) throw new Error("speechUnavailable");
  return new Blob(chunks, { type });
}

async function responseError(response) {
  let code;
  try { code = (await response.json()).error; } catch { /* A proxy may return a non-JSON error. */ }
  const known = {
    speech_busy: "speechBusy", speech_unavailable: "speechUnavailable",
    speech_language_unavailable: "speechLanguageUnavailable",
    cloud_not_connected: "cloud_not_connected", account_changed: "account_changed",
    not_found: "notFound",
  };
  return new Error(known[code] || (response.status === 404 ? "notFound" : "speechUnavailable"));
}

async function audioDataURL(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:${blob.type};base64,${btoa(binary)}`;
}

function audioContext() {
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  return Context ? new Context() : null;
}
const errorNames = new Set(["Error", "TypeError", "NotAllowedError", "NotSupportedError", "InvalidStateError",
  "AbortError", "EncodingError", "SecurityError", "NetworkError", "TimeoutError"]);
const publicErrors = new Set(["speechBusy", "speechUnavailable", "speechLanguageUnavailable", "notFound",
  "cloud_not_connected", "account_changed", "accountSuperseded", "authenticationRequired", "accountChanged", "disconnected"]);
const diagnosticStages = new Set(["context", "request", "read", "decode", "start", "playing", "ended", "media"]);
function gestureError() { return new DOMException("", "NotAllowedError"); }

// The controller owns only playback. Text, language and voice selection stay on
// the authenticated backend, so neither operating-system voices nor polling is needed.
export class PronunciationController {
  constructor({ requestAudio, canPlay = () => true, onState = () => {}, onError = () => {},
    onDiagnostic = () => {}, createAudioContext = audioContext, resumeTimeoutMs = 1200,
    createAudio = (url) => new Audio(url), createObjectURL = (blob) => URL.createObjectURL(blob),
    revokeObjectURL = (url) => URL.revokeObjectURL(url), sourceMode = "blob", createDataURL = audioDataURL }) {
    if (!["blob", "data"].includes(sourceMode)) throw new TypeError("Invalid audio source mode");
    Object.assign(this, { requestAudio, canPlay, onState, onError, onDiagnostic, createAudioContext, resumeTimeoutMs,
      createAudio, createObjectURL, revokeObjectURL, sourceMode, createDataURL });
    this.generation = 0;
    this.current = null;
    this.context = null;
  }

  active(operation) {
    return this.current === operation && operation.generation === this.generation && this.canPlay();
  }

  state(operation, phase) {
    operation.phase = phase;
    this.onState({ recordId: operation.recordId, phase });
  }

  diagnostic(operation, stage, error) {
    operation.stage = diagnosticStages.has(stage) ? stage : "start";
    const diagnostic = { stage: operation.stage, engine: operation.engine === "media" ? "media" : "web-audio" };
    if (error) diagnostic.errorName = errorNames.has(error.name) ? error.name : "Error";
    const mediaCode = operation.audio?.error?.code;
    if (Number.isInteger(mediaCode) && mediaCode >= 1 && mediaCode <= 4) diagnostic.mediaCode = mediaCode;
    this.lastDiagnostic = Object.freeze(diagnostic);
    this.onDiagnostic(this.lastDiagnostic);
  }

  activate(operation) {
    if (operation.engine === "media") return;
    this.diagnostic(operation, "context");
    if (!this.context || this.context.state === "closed") this.context = this.createAudioContext();
    if (!this.context) { operation.engine = "media"; return; }
    operation.engine = "web-audio";
    operation.context = this.context;
    // This call must execute in the original click stack, before fetching or
    // decoding. An autoplay-blocked resume promise may never settle, so bound
    // the wait and preserve the decoded buffer for the next user gesture.
    const context = operation.context;
    let resume;
    try { resume = context.state === "running" ? undefined : context.resume(); }
    catch (error) { resume = Promise.reject(error); }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(gestureError()), this.resumeTimeoutMs);
    });
    const canceled = new Promise((_, reject) => {
      operation.cancelActivation = () => reject(new DOMException("", "AbortError"));
    });
    operation.activation = Promise.race([Promise.resolve(resume).then(() => {
      if (context.state !== "running") throw gestureError();
    }), timeout, canceled]).then(() => ({ ok: true }), (error) => ({ ok: false, error })).finally(() => {
      clearTimeout(timer);
      delete operation.cancelActivation;
    });
  }

  stop(recordId) {
    const operation = this.current;
    if (recordId !== undefined && operation?.recordId !== recordId) return;
    ++this.generation;
    this.current = null;
    if (!operation) return;
    operation.cancelActivation?.();
    operation.reader?.cancel().catch(() => {});
    if (operation.source) {
      operation.source.onended = null;
      try { operation.source.stop(); } catch { /* A source that has ended is already stopped. */ }
      operation.source.disconnect();
      delete operation.source;
    }
    if (operation.audio) {
      operation.audio.removeEventListener("ended", operation.ended);
      operation.audio.removeEventListener("error", operation.failed);
      operation.audio.pause();
      operation.audio.removeAttribute("src");
      operation.audio.load();
    }
    if (operation.url && operation.objectURL) this.revokeObjectURL(operation.url);
    delete operation.url;
    delete operation.buffer;
    delete operation.blob;
    this.onState(null);
  }

  fail(operation, error) {
    if (this.current !== operation) return;
    if (!this.canPlay()) { this.stop(); return; }
    this.diagnostic(operation, operation.stage || "start", error);
    if (error?.name === "NotAllowedError" && (operation.buffer || operation.audio)) {
      this.state(operation, "ready");
      this.onError(new Error("speechTapToPlay"));
      return;
    }
    this.stop();
    this.onError(error instanceof Error && publicErrors.has(error.message) ? error : new Error("speechUnavailable"));
  }

  async play(operation) {
    if (operation.engine === "web-audio") {
      this.diagnostic(operation, "context");
      const activation = await operation.activation;
      if (!this.active(operation)) { if (this.current === operation) this.stop(); return; }
      if (!activation.ok) throw activation.error;
      if (operation.context.state !== "running") throw gestureError();
      this.diagnostic(operation, "start");
      const source = operation.context.createBufferSource();
      operation.source = source;
      source.buffer = operation.buffer;
      source.connect(operation.context.destination);
      source.onended = () => {
        if (this.current !== operation || operation.source !== source) return;
        this.diagnostic(operation, "ended");
        this.stop();
      };
      source.start();
    } else {
      this.diagnostic(operation, "start");
      // On a ready-state retry this runs synchronously in the new click stack.
      await operation.audio.play();
      if (!this.active(operation)) { if (this.current === operation) this.stop(); return; }
    }
    this.diagnostic(operation, "playing");
    this.state(operation, "playing");
  }

  async toggle(recordId) {
    if (this.current?.recordId === recordId) {
      if (this.current.phase !== "ready") { this.stop(); return; }
      const operation = this.current;
      if (!this.active(operation)) { this.stop(); return; }
      this.state(operation, "loading");
      try { this.activate(operation); await this.play(operation); }
      catch (error) { this.fail(operation, error); }
      return;
    }
    this.stop();
    if (!this.canPlay()) return;
    const operation = { recordId, generation: this.generation };
    this.current = operation;
    this.state(operation, "loading");
    try {
      this.activate(operation);
      this.diagnostic(operation, "request");
      const response = await this.requestAudio(recordId);
      if (!this.active(operation)) {
        await response.body?.cancel().catch(() => {});
        if (this.current === operation) this.stop();
        return;
      }
      if (!response.ok) throw await responseError(response);
      this.diagnostic(operation, "read");
      const blob = await audioBlob(response, operation);
      if (!this.active(operation)) { if (this.current === operation) this.stop(); return; }
      if (operation.engine === "web-audio") {
        this.diagnostic(operation, "decode");
        const bytes = await blob.arrayBuffer();
        if (!this.active(operation)) { if (this.current === operation) this.stop(); return; }
        operation.buffer = await operation.context.decodeAudioData(bytes);
        if (!this.active(operation)) { if (this.current === operation) this.stop(); return; }
        await this.play(operation);
        return;
      }
      // The native resource explicitly declares data: media for this fallback.
      // Web pages use their explicit blob: policy; Web Audio needs neither URL.
      const url = this.sourceMode === "data" ? await this.createDataURL(blob) : this.createObjectURL(blob);
      if (!this.active(operation)) {
        if (this.sourceMode === "blob") this.revokeObjectURL(url);
        if (this.current === operation) this.stop();
        return;
      }
      operation.url = url;
      operation.objectURL = this.sourceMode === "blob";
      operation.audio = this.createAudio(operation.url);
      operation.ended = () => { if (this.current === operation) this.stop(); };
      operation.failed = () => {
        if (this.current !== operation) return;
        this.diagnostic(operation, "media", new Error("speechUnavailable"));
        this.stop();
        this.onError(new Error("speechUnavailable"));
      };
      operation.audio.addEventListener("ended", operation.ended);
      operation.audio.addEventListener("error", operation.failed);
      await this.play(operation);
    } catch (error) {
      this.fail(operation, error);
    }
  }
}
