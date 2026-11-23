/** Inline editing with automatic saves and protection for concurrent changes. */
import { parseScenes } from "./scene-model.js";

export class EntryEditor {
  constructor(record, helpers) {
    this.record = record;
    Object.assign(this, helpers);
    this.pending = {};
    this.running = null;
    this.error = null;
    this.node = this.render();
  }

  get dirty() { return !!this.running || !!this.invalidSceneDraft || !!this.sceneComposing || Object.keys(this.pending).length > 0; }

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

  dispose() {
    this.noteObserver?.disconnect();
    this.noteObserver = undefined;
    if (this.resizeFrame !== undefined) cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = undefined;
    this.observedNote = undefined;
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
    this.footer.hidden = !this.error;
    this.feedback.textContent = this.error ? this.t(key) : "";
    this.feedback.classList.toggle("error", !!this.error);
    this.retry.hidden = !this.error || ["editConflict", "invalidScenes"].includes(this.error);
    this.reload.hidden = !this.error;
  }

  async flush() {
    clearTimeout(this.timer);
    if (this.composing || this.sceneComposing || this.invalidSceneDraft) return false;
    if (this.running) return this.running;
    if (this.error === "editConflict") return false;
    this.running = (async () => {
      while (Object.keys(this.pending).length) {
        if (this.invalidSceneDraft || this.sceneComposing) return false;
        const patch = this.pending;
        this.pending = {};
        try {
          const result = await this.api("points/update", {
            record_id: this.record.id, patch, expected_revision: this.record.revision,
          });
          this.record = result.record;
          this.error = this.invalidSceneDraft ? "invalidScenes" : null;
          this.onChange(this.record);
          this.reflect(this.error || "saved");
        } catch (error) {
          this.pending = { ...patch, ...this.pending };
          this.error = error.message;
          this.reflect(this.error);
          return false;
        }
      }
      return !this.invalidSceneDraft && !this.sceneComposing;
    })();
    try { return await this.running; }
    finally { this.running = null; }
  }

  async reloadSaved() {
    try {
      const result = await this.api("points/read", { record_id: this.record.id });
      clearTimeout(this.timer);
      this.record = result.record;
      this.pending = {};
      this.invalidSceneDraft = false;
      this.error = null;
      const old = this.node;
      this.node = this.render();
      old.replaceWith(this.node);
      this.onChange(this.record);
    } catch (error) {
      if (error.message === "notFound") {
        this.pending = {};
        this.error = null;
        await this.onDeleted(this.record);
      } else { this.error = error.message; this.reflect(this.error); }
    }
  }

  async setStatus(status) {
    if (!(await this.flush())) return false;
    if (this.record.status === status) return true;
    this.queue({ status });
    return this.flush();
  }

  render() {
    this.dispose();
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
