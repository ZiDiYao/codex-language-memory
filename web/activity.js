const eventKinds = new Set(["button", "pronunciation"]);
const batchSize = 20;
const maxQueued = 100;
const maxEventAge = 4 * 60 * 1000;

function browserTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}

export function activityEventId(crypto = globalThis.crypto) {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Only explicitly marked study controls count; targets and their text never leave the page. */
export function isStudyClick(event) {
  if (event?.isTrusted !== true || typeof event.target?.closest !== "function") return false;
  if (event.target.closest("[data-activity-ignore], .entry-listen")) return false;
  const control = event.target.closest('button, input[type="checkbox"], summary, [role="option"]');
  return !!control && !control.disabled && !control.closest("[inert]") &&
    !!control.closest("[data-study-activity]");
}

/** Memory-only, best-effort event batches. This never calls a model or stores note content. */
export class ActivityController {
  constructor({ request, canUse = () => true, timezone = browserTimezone, onData = () => {},
    onLoading = () => {}, onError = () => {}, onClear = () => {},
    now = () => Date.now(), uuid = activityEventId,
    schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
    cancel = (timer) => globalThis.clearTimeout(timer), batchDelay = 10000, cacheLifetime = 0, writeWaitMs = 2000 }) {
    Object.assign(this, { request, canUse, timezone, onData, onLoading, onError, onClear,
      now, uuid, schedule, cancel, batchDelay, cacheLifetime, writeWaitMs });
    this.generation = 0;
    this.readVersion = 0;
    this.queue = [];
    this.opened = false;
    this.cache = null;
    this.pendingRead = null;
    this.writing = false;
    this.writeSettled = null;
    this.writeWaiters = new Set();
    this.timer = null;
  }

  record(kind) {
    if (!eventKinds.has(kind) || !this.canUse() || this.queue.length >= maxQueued) return false;
    let event;
    try { event = { event_id: this.uuid(), kind, occurred_at: new Date(this.now()).toISOString() }; }
    catch { return false; }
    this.queue.push(event);
    this.scheduleBatch();
    return true;
  }

  scheduleBatch() {
    if (this.timer !== null || this.writing || !this.queue.length || !this.canUse()) return;
    const generation = this.generation;
    this.timer = this.schedule(() => {
      this.timer = null;
      if (generation === this.generation) void this.flush();
    }, this.batchDelay);
  }

  async flush() {
    if (this.writing || !this.canUse()) return false;
    if (this.timer !== null) { this.cancel(this.timer); this.timer = null; }
    const generation = this.generation;
    const cutoff = this.now() - maxEventAge;
    this.queue = this.queue.filter((event) => Date.parse(event.occurred_at) >= cutoff);
    const events = this.queue.splice(0, batchSize);
    if (!events.length) return false;
    this.writing = true;
    let settle;
    const writing = this.writeSettled = new Promise((resolve) => { settle = resolve; });
    try {
      await this.request("activity/events", { events });
      if (generation !== this.generation || !this.canUse()) return false;
      this.cachedAt = -Infinity;
      return true;
    } catch { return false; } // Interaction delivery must never interrupt learning or retry under another account.
    finally {
      settle();
      if (generation === this.generation && this.writeSettled === writing) {
        this.writing = false;
        this.writeSettled = null;
        this.scheduleBatch();
      }
    }
  }

  async settleBeforeRead(generation, version) {
    let waiting = true, timer, cancelWait;
    const active = () => waiting && generation === this.generation && version === this.readVersion && this.canUse();
    const canceled = new Promise((resolve) => {
      cancelWait = () => resolve(false);
      this.writeWaiters.add(cancelWait);
    });
    const timeout = new Promise((_, reject) => {
      timer = globalThis.setTimeout(() => reject(new Error("activityUnavailable")), this.writeWaitMs);
    });
    const delivery = (async () => {
      if (this.writeSettled) await this.writeSettled;
      if (!active()) return false;
      if (this.queue.length) await this.flush();
      return active();
    })();
    try { return await Promise.race([delivery, canceled, timeout]); }
    finally {
      waiting = false;
      globalThis.clearTimeout(timer);
      this.writeWaiters.delete(cancelWait);
    }
  }

  open() {
    this.opened = true;
    if (!this.canUse()) { this.onClear(); return Promise.resolve(false); }
    if (!this.queue.length && !this.writeSettled && this.cacheLifetime > 0 && this.cache &&
        this.cachedTimezone === this.timezone() && this.now() - this.cachedAt < this.cacheLifetime) {
      this.onData(this.cache);
      return Promise.resolve(true);
    }
    return this.pendingRead || this.refresh();
  }

  refresh() {
    if (!this.canUse()) { this.onClear(); return Promise.resolve(false); }
    const generation = this.generation;
    const version = ++this.readVersion;
    const timezone = this.timezone();
    if (this.opened) this.onLoading(true);
    const reading = (async () => {
      await Promise.resolve();
      try {
        if (generation !== this.generation || version !== this.readVersion || !this.canUse()) return false;
        if (!(await this.settleBeforeRead(generation, version))) return false;
        if (generation !== this.generation || version !== this.readVersion || !this.canUse()) return false;
        const data = await this.request("activity/read", { timezone });
        if (generation !== this.generation || version !== this.readVersion || !this.canUse()) return false;
        if (!data || typeof data.timezone !== "string" || !Array.isArray(data.days) || data.days.length !== 182)
          throw new Error("activityUnavailable");
        this.cache = data;
        this.cachedTimezone = timezone;
        this.cachedAt = this.now();
        if (this.opened) this.onData(data);
        return true;
      } catch {
        if (generation === this.generation && version === this.readVersion && this.opened && this.canUse())
          this.onError(new Error("activityUnavailable"));
        return false;
      } finally {
        if (generation === this.generation && version === this.readVersion) {
          this.pendingRead = null;
          if (this.opened) this.onLoading(false);
        }
      }
    })();
    this.pendingRead = reading;
    return reading;
  }

  close() { this.opened = false; this.onLoading(false); }
  relabel() { if (this.opened && this.cache) this.onData(this.cache); }

  invalidate() {
    ++this.generation;
    ++this.readVersion;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.queue = [];
    this.cache = null;
    this.pendingRead = null;
    this.writing = false;
    this.writeSettled = null;
    for (const cancelWait of this.writeWaiters) cancelWait();
    this.writeWaiters.clear();
    this.opened = false;
    this.onLoading(false);
    this.onClear();
  }
}
