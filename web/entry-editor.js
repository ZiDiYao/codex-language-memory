/** Inline editing with automatic saves and protection for concurrent changes. */
import { parseScenes } from "./scene-model.js";

export class EntryEditor {
  constructor(record, helpers) {
    this.record = record;
    Object.assign(this, helpers);
    this.pending = {};
    this.running = null;
    this.inflightPatch = null;
    this.error = null;
    this.statusIntent = null;
    this.statusSequence = 0;
    this.statusRolledBack = false;
    this.statusUncertain = false;
    this.generation = 0;
    this.disposed = false;
    this.node = this.render();
  }

  get dirty() { return !!this.running || !!this.invalidSceneDraft || !!this.sceneComposing || Object.keys(this.pending).length > 0; }

  get hasUnsavedText() {
    return !!this.composing || !!this.sceneComposing || !!this.invalidSceneDraft ||
      [...Object.keys(this.pending), ...Object.keys(this.inflightPatch ?? {})].some((key) => key !== "status");
  }

  get visibleRecord() {
    return this.statusIntent && !this.statusRolledBack ? { ...this.record, status: this.statusIntent.value } : this.record;
  }

  active(generation = this.generation) {
    return !this.disposed && generation === this.generation && (!this.isCurrent || this.isCurrent());
  }

  emit() { if (this.active()) this.onChange(this.visibleRecord); }

  text(tag, value, className = "") {
    const node = document.createElement(tag);
    node.textContent = value;
    node.className = className;
    return node;
  }

  button(key, handler, className = "subtle") {
    const button = this.text("button", this.t(key), className);
    button.type = "button";
    button.addEventListener("click", handler);
    return button;
  }

  resize(input) {
    input.style.height = "auto";
    input.style.height = `${Math.max(input.scrollHeight, 32)}px`;
  }

  cleanupView() {
    this.noteObserver?.disconnect();
    this.noteObserver = undefined;
    if (this.resizeFrame !== undefined) cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = undefined;
    this.observedNote = undefined;
  }

  dispose() {
    this.cleanupView();
    clearTimeout(this.timer);
    this.disposed = true;
    this.generation = (this.generation ?? 0) + 1;
    this.statusIntent = null;
    delete this.pending.status;
  }

  queueNoteResize(input) {
    if (this.resizeFrame !== undefined) cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = undefined;
      if (this.observedNote === input && input.isConnected) this.resize(input);
    });
  }

  observeNote(input) {
    this.observedNote = input;
    this.queueNoteResize(input);
    if (typeof ResizeObserver !== "function") return;
    let width;
    this.noteObserver = new ResizeObserver(([entry]) => {
      if (!entry || this.observedNote !== input) return;
      const nextWidth = entry.contentRect.width;
      if (nextWidth === width) return;
      width = nextWidth;
      // Height writes trigger observer notifications too; only width can reflow
      // existing text. Skip collapsed notes until they become visible again.
      if (width > 0) this.queueNoteResize(input);
    });
    this.noteObserver.observe(input);
  }

  note(value) {
    const input = document.createElement("textarea");
    this.noteInput = input;
    input.className = "entry-note";
    input.setAttribute("aria-label", this.t("note"));
    input.rows = 6;
    input.maxLength = 30000;
    input.value = value;
    input.placeholder = this.t("notePlaceholder");
    input.dir = "auto";
    input.addEventListener("compositionstart", () => { this.composing = true; clearTimeout(this.timer); });
    input.addEventListener("compositionend", () => {
      this.composing = false;
      this.queue({ note: input.value });
    });
    input.addEventListener("input", () => { this.resize(input); this.queue({ note: input.value }); });
    input.addEventListener("blur", () => this.flush());
    this.observeNote(input);
    return input;
  }

  queue(patch) {
    if (!this.active()) return;
    Object.assign(this.pending, patch);
    if (this.error !== "editConflict") this.error = this.invalidSceneDraft ? "invalidScenes" : null;
    this.reflect(this.error || "saving");
    clearTimeout(this.timer);
    if (!this.error && !this.composing) this.timer = setTimeout(() => this.flush(), 650);
  }

  scenes(values) {
    const label = this.text("label", "", "entry-scenes");
    label.append(this.text("span", this.t("scenes")));
    const input = document.createElement("input");
    this.sceneInput = input;
    input.type = "text";
    input.className = "entry-scenes-input";
    input.value = (values || []).join(", ");
    input.placeholder = this.t("scenesPlaceholder");
    input.maxLength = 1000;
    input.dir = "auto";
    input.setAttribute("aria-label", this.t("scenes"));
    input.title = this.t("scenesHelp");
    const update = () => {
      if (this.sceneComposing) return;
      try {
        const scenes = parseScenes(input.value);
        this.invalidSceneDraft = false;
        input.removeAttribute("aria-invalid");
        this.queue({ scenes });
      } catch {
        clearTimeout(this.timer);
        this.invalidSceneDraft = true;
        input.setAttribute("aria-invalid", "true");
        if (this.error !== "editConflict") this.error = "invalidScenes";
        this.reflect(this.error);
      }
    };
    input.addEventListener("compositionstart", () => {
      this.sceneComposing = true;
      clearTimeout(this.timer);
    });
    input.addEventListener("compositionend", () => { this.sceneComposing = false; update(); });
    input.addEventListener("input", update);
    input.addEventListener("blur", () => this.flush());
    label.append(input);
    return label;
  }

  reflect(key) {
    if (this.disposed) return;
    this.footer.hidden = !this.error;
    this.feedback.textContent = this.error ? this.t(key) : "";
    this.feedback.classList.toggle("error", !!this.error);
    this.retry.hidden = !this.error || ["editConflict", "invalidScenes"].includes(this.error);
    this.reload.hidden = !this.error;
  }

  syncSavedText() {
    if (this.hasUnsavedText) return;
    if (this.noteInput) {
      this.noteInput.value = this.record.note ?? "";
      this.queueNoteResize(this.noteInput);
    }
    if (this.sceneInput) this.sceneInput.value = (this.record.scenes ?? []).join(", ");
  }

  async flush() {
    clearTimeout(this.timer);
    if (!this.active()) return false;
    if (this.running) return this.running;
    const blockedNotes = () => this.composing || this.sceneComposing || this.invalidSceneDraft || this.error === "editConflict";
    const hasStatus = () => Object.hasOwn(this.pending, "status");
    if (blockedNotes() && !hasStatus()) return false;
    if (hasStatus() && this.statusIntent && this.statusRolledBack && this.error !== "editConflict") {
      this.statusRolledBack = false;
      this.emit();
    }
    const generation = this.generation;
    const writing = (async () => {
      // Publish ownership before a synchronous transport or another click can enter.
      await Promise.resolve();
      while (Object.keys(this.pending).length) {
        if (!this.active(generation)) return false;
        if (hasStatus() && !this.statusUncertain && this.pending.status === this.record.status) {
          delete this.pending.status;
          if (this.statusIntent?.value === this.record.status) this.statusIntent = null;
          if (this.error === "editConflict" && !this.hasUnsavedText) { this.error = null; this.reflect("saved"); }
          this.emit();
        }
        if (!Object.keys(this.pending).length) break;
        if (blockedNotes() && !hasStatus()) return false;
        let patch;
        const preserveNoteConflict = this.error === "editConflict" && this.hasUnsavedText;
        if (blockedNotes()) {
          patch = { status: this.pending.status };
          delete this.pending.status;
        } else {
          patch = this.pending;
          this.pending = {};
        }
        this.inflightPatch = patch;
        try {
          let result, rebased = false;
          const mayRebaseStatus = () => Object.keys(patch).length === 1 && Object.hasOwn(patch, "status") &&
            !Object.keys(this.pending).some((key) => key !== "status") && !this.composing &&
            !this.sceneComposing && !this.invalidSceneDraft && !preserveNoteConflict;
          while (true) {
            if (!this.active(generation)) return false;
            try {
              result = await this.api("points/update", {
                record_id: this.record.id, patch, expected_revision: this.record.revision,
              });
              break;
            } catch (error) {
              if (!this.active(generation)) return false;
              if (error.message !== "editConflict" || rebased || !mayRebaseStatus()) throw error;
              rebased = true;
              const latest = await this.api("points/read", { record_id: this.record.id });
              if (!this.active(generation)) return false;
              this.record = latest.record;
              if (mayRebaseStatus()) this.syncSavedText();
              this.emit();
              if (!mayRebaseStatus()) throw error;
              patch = { status: this.statusIntent?.value ?? patch.status };
              this.inflightPatch = patch;
              if (this.pending.status === patch.status) delete this.pending.status;
              if (this.record.status === patch.status) { result = latest; break; }
            }
          }
          if (!this.active(generation)) return false;
          this.record = result.record;
          this.statusUncertain = false;
          if (this.pending.status === this.record.status) delete this.pending.status;
          if (!Object.hasOwn(this.pending, "status") && this.statusIntent?.value === this.record.status) this.statusIntent = null;
          this.statusRolledBack = false;
          this.error = preserveNoteConflict ? "editConflict" : this.invalidSceneDraft ? "invalidScenes" : null;
          this.emit();
          this.reflect(this.error || "saved");
        } catch (error) {
          if (!this.active(generation)) return false;
          this.pending = { ...patch, ...this.pending };
          this.error = error.message;
          this.statusUncertain = error.message !== "editConflict";
          this.statusRolledBack = true;
          this.emit();
          this.reflect(this.error);
          return false;
        } finally {
          // Keep text copyable after an account change, without reviving its writer.
          if (this.disposed || (this.isCurrent && !this.isCurrent())) {
            const text = Object.fromEntries(Object.entries(patch).filter(([key]) => key !== "status"));
            this.pending = { ...text, ...this.pending };
          }
          if (this.inflightPatch === patch) this.inflightPatch = null;
        }
      }
      return !this.invalidSceneDraft && !this.sceneComposing && !this.composing && this.error !== "editConflict";
    })();
    this.running = writing;
    try { return await writing; }
    finally { if (this.running === writing) this.running = null; }
  }

  async reloadSaved() {
    if (!this.active()) return false;
    const generation = this.generation = (this.generation ?? 0) + 1;
    this.running = null;
    try {
      const result = await this.api("points/read", { record_id: this.record.id });
      if (!this.active(generation)) return false;
      clearTimeout(this.timer);
      this.record = result.record;
      this.pending = {};
      this.inflightPatch = null;
      this.statusIntent = null;
      this.statusRolledBack = this.statusUncertain = false;
      this.invalidSceneDraft = false;
      this.error = null;
      const old = this.node;
      this.node = this.render();
      old.replaceWith(this.node);
      this.emit();
    } catch (error) {
      if (!this.active(generation)) return false;
      if (error.message === "notFound") {
        this.pending = {};
        this.statusIntent = null;
        this.statusRolledBack = this.statusUncertain = false;
        this.error = null;
        await this.onDeleted(this.record);
      } else { this.error = error.message; this.reflect(this.error); }
    }
  }

  async setStatus(status) {
    if (!this.active() || !["new", "mastered"].includes(status)) return false;
    if (this.record.status === status && !this.statusIntent && !this.statusUncertain && !Object.hasOwn(this.pending, "status")) return this.flush();
    this.statusIntent = { value: status, sequence: this.statusSequence = (this.statusSequence ?? 0) + 1 };
    this.pending.status = status;
    this.statusRolledBack = false;
    if (this.error !== "editConflict") this.error = this.invalidSceneDraft ? "invalidScenes" : null;
    this.emit();
    return this.flush();
  }

  render() {
    this.cleanupView();
    const record = this.record;
    const article = document.createElement("article");
    article.className = "entry-editor";
    article.dataset.id = record.id;
    const meta = this.text("div", `${this.t(record.kind)} · ${this.languageName(record.language)}`, "entry-meta");
    meta.append(this.text("span", this.t("lastSeen", { date: record.last_seen_at })));
    article.append(meta, this.note(record.note), this.scenes(record.scenes));
    this.footer = this.text("div", "", "entry-footer");
    this.footer.hidden = true;
    this.feedback = this.text("span", "", "help");
    this.feedback.setAttribute("role", "status");
    this.retry = this.button("retry", () => { this.error = null; this.flush(); });
    this.reload = this.button("reloadSaved", () => this.reloadSaved());
    this.retry.hidden = this.reload.hidden = true;
    this.footer.append(this.feedback, this.retry, this.reload);
    article.append(this.footer);
    return article;
  }
}
