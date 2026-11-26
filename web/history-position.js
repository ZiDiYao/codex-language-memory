const filterFields = new Set(["keyword", "kind", "scene", "language", "status", "include_variants", "needs_enrichment"]);
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const copy = (value) => JSON.parse(JSON.stringify(value));

export function historyFilterKey(filters) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters) || Object.keys(filters).some((key) => !filterFields.has(key))) return null;
  for (const [key, value] of Object.entries(filters)) {
    if (["include_variants", "needs_enrichment"].includes(key) ? typeof value !== "boolean" : typeof value !== "string") return null;
  }
  const key = JSON.stringify(filters);
  return key.length <= 1500 ? key : null;
}

export function validHistoryState(value) {
  if (!value || typeof value !== "object" || typeof value.filter_key !== "string" || value.filter_key.length > 1500) return false;
  let keyed;
  try { keyed = JSON.parse(value.filter_key); } catch { return false; }
  if (historyFilterKey(keyed) !== value.filter_key) return false;
  const semantic = (filters) => {
    if (!filters || typeof filters !== "object" || Array.isArray(filters) || Object.keys(filters).some((key) => !filterFields.has(key))) return null;
    return JSON.stringify(Object.entries(filters).filter(([key, item]) => item != null && item !== "" &&
      !(["include_variants", "needs_enrichment"].includes(key) && item === false)).sort(([a], [b]) => a.localeCompare(b)));
  };
  if (semantic(value.filters) === null || semantic(value.filters) !== semantic(keyed)) return false;
  const view = value.view;
  return !!view && typeof view === "object" && (view.anchor_id === null || integer(view.anchor_id, 1)) &&
    Number.isFinite(view.anchor_top) && Number.isFinite(view.scroll_y) && view.scroll_y >= 0 && integer(view.loaded_count, 1) &&
    view.loaded_count <= 2000 && Array.isArray(view.expanded_ids) && view.expanded_ids.length <= 100 &&
    view.expanded_ids.every((id) => integer(id, 1)) && integer(view.latest_point_id);
}

function bounded(promise, milliseconds, fallback = null) {
  let timer;
  return Promise.race([Promise.resolve(promise).catch(() => fallback), new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

/** Website-only storage. Identity is hashed; notes and authentication are never stored. */
export function createBrowserHistoryStorage({ apiBaseUrl, issuer, subject, storage, crypto = globalThis.crypto }) {
  const entries = new Map();
  let lastKey = null, loaded;
  const scope = (async () => {
    try {
      const identity = JSON.stringify([new URL(apiBaseUrl).origin, issuer, subject]);
      if (typeof issuer !== "string" || typeof subject !== "string" || !subject) return null;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
      return "sayrove.history.v1." + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch { return null; }
  })();
  const getStorage = () => { try { return storage === undefined ? globalThis.localStorage : storage; } catch { return null; } };
  const hydrate = () => loaded ??= (async () => {
    try {
      const key = await scope, raw = key && getStorage()?.getItem(key);
      if (!raw || raw.length > 100000) return;
      const data = JSON.parse(raw);
      if (!Array.isArray(data.entries) || data.entries.length > 12) return;
      for (const state of data.entries) if (validHistoryState(state)) entries.set(state.filter_key, copy(state));
      if (entries.has(data.last_key)) lastKey = data.last_key;
    } catch { /* A blocked or unavailable store keeps an isolated in-memory view. */ }
  })();
  return {
    async read({ filter_key } = {}) {
      await hydrate();
      return copy(entries.get(filter_key ?? lastKey) ?? { filter_key: null, filters: null, view: null });
    },
    async write(state) {
      if (!validHistoryState(state)) return null;
      await hydrate();
      entries.delete(state.filter_key);
      entries.set(state.filter_key, copy(state));
      lastKey = state.filter_key;
      while (entries.size > 12) entries.delete(entries.keys().next().value);
      try {
        const key = await scope;
        if (key) getStorage()?.setItem(key, JSON.stringify({ last_key: lastKey, entries: [...entries.values()] }));
      } catch { /* The memory copy remains useful when browser storage is full. */ }
      return copy(state);
    },
  };
}

/** A creation watermark is acknowledged only after a successful open/restore. */
export class HistoryPosition {
  constructor({ storage, getFilters, capture, restore, canUse = () => true, readTimeout = 1200 }) {
    Object.assign(this, { storage, getFilters, capture, restore, canUse, readTimeout });
    this.generation = this.restoreVersion = 0;
    this.latestPointId = 0;
    this.acknowledgedPointId = null;
    this.activeFilters = null;
    this.views = new Map();
    this.writes = Promise.resolve();
    this.writeVersions = new Map();
    this.pending = null;
  }

  get restoring() { return !!this.pending; }
  observe(value) { if (integer(value)) this.latestPointId = Math.max(this.latestPointId, value); }
  committed(filters) { if (historyFilterKey(filters)) this.activeFilters = copy(filters); }

  snapshot() {
    if (!this.activeFilters) return null;
    const filters = copy(this.activeFilters);
    const state = { filter_key: historyFilterKey(filters), filters, view: {
      ...this.capture(), latest_point_id: this.acknowledgedPointId ?? this.latestPointId,
    } };
    return validHistoryState(state) ? state : null;
  }

  save({ force = false } = {}) {
    if (!this.canUse() || (this.restoring && !force)) return this.writes;
    const state = this.snapshot();
    if (!state) return this.writes;
    this.views.set(state.filter_key, copy(state));
    const generation = this.generation, version = (this.writeVersions.get(state.filter_key) ?? 0) + 1;
    this.writeVersions.set(state.filter_key, version);
    this.writes = this.writes.then(async () => {
      if (generation !== this.generation || !this.canUse() || this.writeVersions.get(state.filter_key) !== version) return false;
      try { await this.storage.write(state); return generation === this.generation; } catch { return false; }
    });
    return this.writes;
  }

  flush() { return bounded(this.save(), 1000, false); }

  resume({ initial = false, contentVersion } = {}) {
    if (this.pending) return this.pending;
    if (!this.canUse()) return Promise.resolve(false);
    const generation = this.generation, version = ++this.restoreVersion, latest = this.latestPointId;
    const isCurrent = () => generation === this.generation && version === this.restoreVersion && this.canUse();
    const restoring = (async () => {
      await Promise.resolve();
      const currentFilters = this.activeFilters ?? this.getFilters();
      const key = historyFilterKey(currentFilters);
      let saved = initial ? null : this.views.get(key);
      if (!saved) saved = await bounded(this.storage.read(initial ? {} : { filter_key: key }), this.readTimeout);
      if (!isCurrent()) return false;
      if (!validHistoryState(saved)) saved = null;
      else saved = { ...saved, filters: JSON.parse(saved.filter_key) };
      const filters = initial && saved ? saved.filters : currentFilters;
      if (!initial && saved?.filter_key !== key) saved = null;
      const baseline = Math.max(this.acknowledgedPointId ?? 0, saved?.view.latest_point_id ?? 0,
        this.acknowledgedPointId === null && !saved ? latest : 0);
      const toTop = latest > baseline;
      const completed = await this.restore({ state: saved, filters: copy(filters), initial, toTop, isCurrent, contentVersion });
      if (!completed || !isCurrent()) return false;
      this.acknowledgedPointId = Math.max(baseline, latest);
      this.save({ force: true });
      return true;
    })().catch(() => false).finally(() => { if (this.pending === restoring) this.pending = null; });
    this.pending = restoring;
    return restoring;
  }

  cancelRestore() { ++this.restoreVersion; this.pending = null; }

  invalidate() {
    ++this.generation;
    this.cancelRestore();
    this.activeFilters = null;
    this.acknowledgedPointId = null;
    this.latestPointId = 0;
    this.views.clear();
    this.writeVersions.clear();
    this.writes = Promise.resolve();
  }
}
