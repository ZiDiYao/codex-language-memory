/** Desktop cloud account state contains no tokens or identity claims. */
export function authorizationUrl(value) {
  const url = new URL(value);
  if (url.origin !== "https://language-memory.ca.auth0.com" || url.pathname !== "/authorize" ||
      url.username || url.password || url.hash) throw new Error("unavailable");
  return url.href;
}

export function accountStatus(value) {
  const status = value?.status && typeof value.status === "object" ? value.status : value;
  if (!status || status.mode !== "cloud" ||
      !["signed_out", "connecting", "connected", "error"].includes(status.state)) throw new Error("unavailable");
  let authorization_url = null;
  if (typeof status.authorization_url === "string") {
    authorization_url = authorizationUrl(status.authorization_url);
  }
  return { mode: status.mode, state: status.state, epoch: status.epoch ?? null, can_connect: status.can_connect !== false,
    capabilities: status.capabilities || {}, authorization_url };
}

export function accountCanRead(status) {
  return status?.mode === "cloud" && status.state === "connected";
}

function sourceKey(status) {
  return status && JSON.stringify([status.mode, status.epoch, status.state, status.capabilities]);
}

export class LocalAccountSession {
  constructor({ call, beforeChange, onPause, onSourceChange, onState, onError, openExternal,
    schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
    cancel = (timer) => globalThis.clearTimeout(timer) }) {
    Object.assign(this, { call, beforeChange, onPause, onSourceChange, onState, onError, openExternal, schedule, cancel });
    this.status = null;
    this.pending = false;
    this.requestVersion = 0;
    this.stopped = false;
    this.lastOpened = null;
  }
  notify() {
    this.onPause(this.transitioning || !accountCanRead(this.status));
    this.onState(this.status, this.pending);
  }
  async accept(value) {
    const status = accountStatus(value);
    const previous = this.status;
    this.status = status;
    this.transitioning = false;
    this.notify();
    if (sourceKey(previous) !== sourceKey(status)) await this.onSourceChange(status, previous);
    if (status.state === "connecting" && status.authorization_url && status.authorization_url !== this.lastOpened) {
      this.lastOpened = status.authorization_url;
      await this.authorize();
    }
  }
  queue() {
    this.cancel(this.timer);
    if (!this.stopped) this.timer = this.schedule(() => this.refresh(), this.status?.state === "connecting" ? 1000 : 5000);
  }
  async refresh() {
    if (this.pending || this.stopped) return;
    const version = ++this.requestVersion;
    try {
      const result = await this.call("account/status");
      if (version === this.requestVersion && !this.stopped) await this.accept(result);
    } catch { if (version === this.requestVersion) this.onError("accountFailure"); }
    finally { if (version === this.requestVersion) this.queue(); }
  }
  async change(action) {
    if (this.pending || this.stopped || !["account/connect", "account/disconnect"].includes(action)) return false;
    this.pending = true;
    ++this.requestVersion;
    this.cancel(this.timer);
    this.notify();
    try {
      // Keep the existing source active until every draft and setting is saved.
      try { if (!(await this.beforeChange())) { this.onError("accountUnsaved"); return false; } }
      catch { this.onError("accountUnsaved"); return false; }
      this.transitioning = true;
      this.notify();
      await this.accept(await this.call(action));
      return true;
    } catch { this.onError("accountFailure"); return false; }
    finally { this.pending = false; this.transitioning = false; this.notify(); this.queue(); }
  }
  async authorize() {
    if (!this.status?.authorization_url || this.status.state !== "connecting") return;
    try { await this.openExternal(this.status.authorization_url); }
    catch { this.onError("accountOpenHelp"); }
  }
  dispose() { this.stopped = true; ++this.requestVersion; this.cancel(this.timer); }
}

/** app.js owns common dialog Escape/backdrop behavior. */
export function createLocalProfile({ root, t, openDialog, closeDialog, ...options }) {
  const $ = (id) => root.querySelector(`#local-profile-${id}`);
  const trigger = $("open");
  const panel = $("dialog");
  let feedbackKey = null;
  const render = (status, pending = false) => {
    const connected = accountCanRead(status);
    const connecting = status?.state === "connecting";
    $("mode").textContent = t("accountCloud");
    $("status").textContent = t(!status ? "connecting" : connecting ? "accountConnecting" :
      connected ? "accountConnectedHelp" : status.state === "error" ? "accountFailure" : "accountSignedOutHelp");
    $("connect").hidden = !status || status.can_connect === false || connected || connecting;
    $("disconnect").hidden = !connected && !connecting;
    $("footer").hidden = !connected && !connecting;
    $("authorize").hidden = !connecting || !status.authorization_url;
    for (const button of panel.querySelectorAll("[data-account-action]")) button.disabled = pending;
    $("feedback").textContent = feedbackKey ? t(feedbackKey) : "";
  };
  const session = new LocalAccountSession({ ...options, onState: render,
    onError(key) { feedbackKey = key; render(session.status, session.pending); options.onError?.(key); } });
  trigger.addEventListener("click", () => { feedbackKey = null; render(session.status, session.pending); openDialog(panel); trigger.setAttribute("aria-expanded", "true"); session.refresh(); });
  $("close").addEventListener("click", () => closeDialog(panel));
  panel.addEventListener("close", () => { trigger.setAttribute("aria-expanded", "false"); trigger.focus({ preventScroll: true }); });
  for (const [id, action] of [["connect", "account/connect"], ["disconnect", "account/disconnect"]])
    $(id).addEventListener("click", () => { feedbackKey = null; session.change(action); });
  $("authorize").addEventListener("click", () => session.authorize());
  return { session, relabel: () => render(session.status, session.pending) };
}
