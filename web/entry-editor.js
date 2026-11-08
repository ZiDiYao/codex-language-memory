/** Inline editing with automatic saves and protection for concurrent changes. */
export class EntryEditor {
  constructor(record, helpers) {
    this.record = record;
    Object.assign(this, helpers);
    this.pending = {};
    this.running = null;
    this.error = null;
    this.node = this.render();
  }

  get dirty() { return !!this.running || Object.keys(this.pending).length > 0; }

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
    requestAnimationFrame(() => this.resize(input));
    return input;
  }

  queue(patch) {
    Object.assign(this.pending, patch);
    if (this.error !== "editConflict") this.error = null;
    this.reflect(this.error || "saving");
    clearTimeout(this.timer);
    if (!this.error && !this.composing) this.timer = setTimeout(() => this.flush(), 650);
  }

  reflect(key) {
    this.feedback.textContent = this.t(key);
    this.feedback.classList.toggle("error", !!this.error);
    this.retry.hidden = !this.error || this.error === "editConflict";
    this.reload.hidden = !this.error;
  }

  async flush() {
    clearTimeout(this.timer);
    if (this.composing) return false;
    if (this.running) return this.running;
    if (this.error === "editConflict") return false;
    this.running = (async () => {
      while (Object.keys(this.pending).length) {
        const patch = this.pending;
        this.pending = {};
        try {
          const result = await this.api("points/update", {
            record_id: this.record.id, patch, expected_revision: this.record.revision,
          });
          this.record = result.record;
          this.error = null;
          this.onChange(this.record);
          this.reflect("saved");
        } catch (error) {
          this.pending = { ...patch, ...this.pending };
          this.error = error.message;
          this.reflect(this.error);
          return false;
        }
      }
      return true;
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

  async toggleStatus() {
    if (!(await this.flush())) return false;
    this.queue({ status: this.record.status === "mastered" ? "new" : "mastered" });
    return this.flush();
  }

  render() {
    const record = this.record;
    const article = document.createElement("article");
    article.className = "entry-editor";
    article.dataset.id = record.id;
    const meta = this.text("div", `${this.t(record.kind)} · ${this.languageName(record.language)}`, "entry-meta");
    meta.append(this.text("span", this.t("lastSeen", { date: record.last_seen_at })));
    article.append(meta, this.note(record.note));
    const footer = this.text("div", "", "entry-footer");
    this.feedback = this.text("span", this.t("autoSave"), "help");
    this.feedback.setAttribute("role", "status");
    this.retry = this.button("retry", () => { this.error = null; this.flush(); });
    this.reload = this.button("reloadSaved", () => this.reloadSaved());
    this.retry.hidden = this.reload.hidden = true;
    footer.append(this.feedback, this.retry, this.reload);
    article.append(footer);
    return article;
  }
}
