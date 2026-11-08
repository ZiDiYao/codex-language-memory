/** Editable learning documents backed by the same records as the MCP tools. */
export class DocumentEditor {
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

  field(label, value, change, { title = false, language = null, max = 2000 } = {}) {
    const wrapper = document.createElement("label");
    wrapper.className = "document-field";
    wrapper.append(this.text("span", this.t(label), title ? "sr-only" : "document-label"));
    const input = document.createElement("textarea");
    input.className = title ? "document-input document-title" : "document-input";
    input.rows = 1;
    input.maxLength = max;
    input.value = value || "";
    input.placeholder = this.t("addContent");
    if (language) input.lang = language;
    input.addEventListener("input", () => { this.resize(input); change(input.value.trim()); });
    input.addEventListener("blur", () => this.flush());
    wrapper.append(input);
    requestAnimationFrame(() => this.resize(input));
    return wrapper;
  }

  queue(patch) {
    Object.assign(this.pending, patch);
    if (this.error !== "editConflict") this.error = null;
    this.reflect(this.error || "saving");
    clearTimeout(this.timer);
    if (!this.error) this.timer = setTimeout(() => this.flush(), 650);
  }

  reflect(key) {
    this.feedback.textContent = this.t(key);
    this.feedback.classList.toggle("error", !!this.error);
    this.retry.hidden = !this.error || this.error === "editConflict";
    this.reload.hidden = !this.error;
  }

  async flush() {
    clearTimeout(this.timer);
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

  render() {
    const record = this.record;
    const article = document.createElement("article");
    article.className = "document-block";
    article.dataset.id = record.id;
    const meta = this.text("div", `${this.t(record.kind)} · ${this.languageName(record.language)}`, "document-meta");
    const actions = this.text("div", "", "document-actions");
    const mastery = this.button(record.status === "mastered" ? "keepLearning" : "markMastered", async () => {
      mastery.disabled = true;
      try {
        if (!(await this.flush())) return;
        this.queue({ status: this.record.status === "mastered" ? "new" : "mastered" });
        if (await this.flush()) mastery.textContent = this.t(this.record.status === "mastered" ? "keepLearning" : "markMastered");
      } finally { mastery.disabled = false; }
    });
    actions.append(mastery, this.button("askCodex", async () => {
      if (await this.flush()) this.onAsk(this.record);
    }));
    meta.append(actions);
    article.append(meta, this.field("title", record.title, (title) => this.queue({ title }), { title: true, language: record.language, max: 350 }));
    for (const [key, label] of [["meaning", "meaning"], ["explanation", "explanation"], ["context", "context"], ["corrected_sentence", "corrected"]]) {
      if (key === "corrected_sentence" && record.kind !== "correction" && !record[key]) continue;
      article.append(this.field(label, record[key], (value) => this.queue({ [key]: value || (key === "meaning" ? "" : null) }),
        { language: key === "corrected_sentence" ? record.language : null }));
    }
    const examples = document.createElement("div");
    examples.className = "document-examples";
    this.examples = record.examples.map((item) => ({ ...item }));
    const changed = () => this.queue({ examples: this.examples.filter((item) => item.text || item.translation).map((item) => ({ text: item.text, translation: item.translation || null })) });
    const renderExamples = () => {
      examples.replaceChildren(this.text("h3", this.t("examples"), "document-label"));
      this.examples.forEach((example, index) => {
        const block = this.text("div", "", "document-example");
        block.append(
          this.field("exampleText", example.text, (value) => { example.text = value; changed(); }, { language: record.language }),
          this.field("exampleTranslation", example.translation, (value) => { example.translation = value; changed(); }),
          this.button("removeExample", () => { this.examples.splice(index, 1); renderExamples(); changed(); }),
        );
        examples.append(block);
      });
      if (this.examples.length < 5) examples.append(this.button("addExample", () => {
        this.examples.push({ text: "", translation: null }); renderExamples();
        examples.querySelectorAll("textarea")[Math.max(0, this.examples.length * 2 - 2)]?.focus();
      }));
    };
    renderExamples();
    article.append(examples);
    const footer = this.text("div", "", "document-footer");
    this.feedback = this.text("span", this.t("autoSave"), "help");
    this.feedback.setAttribute("role", "status");
    this.retry = this.button("retry", () => { this.error = null; this.flush(); });
    this.reload = this.button("reloadSaved", () => this.reloadSaved());
    this.retry.hidden = this.reload.hidden = true;
    footer.append(this.feedback, this.retry, this.reload);
    const confirmation = this.text("div", "", "actions delete-confirmation");
    confirmation.hidden = true;
    confirmation.append(this.text("span", this.t("deleteQuestion")),
      this.button("confirmDelete", async () => {
        if (!(await this.flush())) return;
        try { await this.api("points/delete", { record_id: record.id }); await this.onDeleted(record); }
        catch (error) { this.error = error.message; this.reflect(this.error); }
      }, "danger"), this.button("cancel", () => { confirmation.hidden = true; }));
    footer.append(this.button("delete", () => { confirmation.hidden = false; }, "subtle delete-action"));
    article.append(footer, confirmation);
    return article;
  }
}
