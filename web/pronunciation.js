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

// The controller owns only playback. Text, language and voice selection stay on
// the authenticated backend, so neither operating-system voices nor polling is needed.
export class PronunciationController {
  constructor({ requestAudio, canPlay = () => true, onState = () => {}, onError = () => {},
    createAudio = (url) => new Audio(url), createObjectURL = (blob) => URL.createObjectURL(blob),
    revokeObjectURL = (url) => URL.revokeObjectURL(url), sourceMode = "blob", createDataURL = audioDataURL }) {
    if (!["blob", "data"].includes(sourceMode)) throw new TypeError("Invalid audio source mode");
    Object.assign(this, { requestAudio, canPlay, onState, onError, createAudio, createObjectURL, revokeObjectURL,
      sourceMode, createDataURL });
    this.generation = 0;
    this.current = null;
  }

  active(operation) {
    return this.current === operation && operation.generation === this.generation && this.canPlay();
  }

  stop(recordId) {
    const operation = this.current;
    if (recordId !== undefined && operation?.recordId !== recordId) return;
    ++this.generation;
    this.current = null;
    if (!operation) return;
    operation.reader?.cancel().catch(() => {});
    if (operation.audio) {
      operation.audio.removeEventListener("ended", operation.ended);
      operation.audio.removeEventListener("error", operation.failed);
      operation.audio.pause();
      operation.audio.removeAttribute("src");
      operation.audio.load();
    }
    if (operation.url && operation.objectURL) this.revokeObjectURL(operation.url);
    delete operation.url;
    this.onState(null);
  }

  async toggle(recordId) {
    if (this.current?.recordId === recordId) { this.stop(); return; }
    this.stop();
    if (!this.canPlay()) return;
    const operation = { recordId, generation: this.generation };
    this.current = operation;
    this.onState({ recordId, phase: "loading" });
    try {
      const response = await this.requestAudio(recordId);
      if (!this.active(operation)) {
        await response.body?.cancel().catch(() => {});
        if (this.current === operation) this.stop();
        return;
      }
      if (!response.ok) throw await responseError(response);
      const blob = await audioBlob(response, operation);
      if (!this.active(operation)) { if (this.current === operation) this.stop(); return; }
      // MCP Apps guarantee data: media in their restrictive default CSP; blob:
      // is not guaranteed by the host. Web pages use their explicit blob: policy.
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
        this.stop();
        this.onError(new Error("speechUnavailable"));
      };
      operation.audio.addEventListener("ended", operation.ended);
      operation.audio.addEventListener("error", operation.failed);
      try { await operation.audio.play(); }
      catch { throw new Error("speechUnavailable"); }
      if (!this.active(operation)) { if (this.current === operation) this.stop(); return; }
      this.onState({ recordId, phase: "playing" });
    } catch (error) {
      if (this.current !== operation) return;
      if (!this.canPlay()) { this.stop(); return; }
      this.stop();
      this.onError(error instanceof Error ? error : new Error("speechUnavailable"));
    }
  }
}
