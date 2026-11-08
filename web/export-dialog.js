import { Picker } from "./picker.js";
import { enter, openDialog } from "./motion.js";
import { exportRange } from "./export-model.js";

/** Keep export choices separate from the history view until a file is requested. */
export class ExportDialog {
  constructor(root, helpers) {
    this.root = root;
    Object.assign(this, helpers);
    this.kinds = new Set();
    this.generation = 0;
    this.pick = (id) => root.querySelector(`#export-${id}`);
    this.pickers = {};
    for (const name of ["language", "status", "date-field", "period", "content"]) {
      this.pickers[name] = new Picker(this.pick(name), {
        label: name, onChange: () => { this.generation++; this.reflect(); },
      });
    }
    root.addEventListener("input", () => { this.generation++; this.reflect(); });
    this.pick("filters").addEventListener("submit", (event) => { event.preventDefault(); this.next(); });
    this.pick("back").addEventListener("click", () => this.showStep(false));
    root.querySelectorAll("[data-format]").forEach(button => {
      button.addEventListener("click", () => this.download(button.dataset.format, this.prepared));
    });
  }

  relabel() {
    const options = (name, label, entries) => {
      this.pickers[name].setLabel(this.t(label));
      this.pickers[name].setOptions(entries.map(([value, key]) => ({value, label: this.t(key)})));
    };
    const language = this.pickers.language;
    language.setLabel(this.t("notebook"));
    language.setOptions([{value:"", label:this.t("allLanguages")}, ...this.getCatalog().languages.map(value => ({value,label:this.languageName(value)}))]);
    options("status", "status", [["", "allStatuses"], ["new", "new"], ["mastered", "mastered"]]);
    options("date-field", "exportDateBasis", [["created_at", "exportAdded"], ["last_seen_at", "exportEncountered"]]);
    options("period", "exportPeriod", [["all", "exportAllTime"], ["7", "exportLast7"], ["30", "exportLast30"], ["90", "exportLast90"], ["custom", "exportCustomDates"]]);
    options("content", "exportContent", [["notes", "exportFullNotes"], ["terms", "exportTermsOnly"], ["sections", "exportChooseSections"]]);
    this.renderKinds();
    if (this.preview) this.renderPreview();
  }

  renderKinds() {
    const host = this.pick("kinds");
    host.setAttribute("role", "group");
    host.setAttribute("aria-label", this.t("kind"));
    host.replaceChildren(...["", "word", "expression", "grammar"].map(kind => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "type-tab";
      button.textContent = this.t(kind || "all");
      button.setAttribute("aria-pressed", String(kind ? this.kinds.has(kind) : !this.kinds.size));
      button.addEventListener("click", () => {
        if (!kind) this.kinds.clear();
        else if (this.kinds.has(kind)) this.kinds.delete(kind);
        else this.kinds.add(kind);
        this.generation++;
        this.renderKinds();
        host.querySelectorAll("button")[["", "word", "expression", "grammar"].indexOf(kind)].focus();
      });
      return button;
    }));
  }

  reflect() {
    this.pick("dates").hidden = this.pickers.period.value !== "custom";
    const sections = this.pickers.content.value === "sections";
    this.pick("fields").hidden = this.pick("source-help").hidden = !sections;
    const examples = this.root.querySelector('[name="export-field"][value="examples"]');
    const translations = this.root.querySelector('[name="export-field"][value="translations"]');
    translations.disabled = !examples.checked;
    if (!examples.checked) translations.checked = false;
  }

  selection() {
    const read = (name) => this.pickers[name].value;
    const fields = read("content") === "sections"
      ? [...this.root.querySelectorAll('[name="export-field"]:checked')].map(input => input.value) : [];
    if (read("content") === "sections" && !fields.length) throw new Error("exportFieldsRequired");
    return {
      language: read("language") || null, status: read("status") || null,
      keyword: this.pick("search").value.trim() || null, include_variants: true,
      kinds: this.kinds.size ? [...this.kinds] : null, date_field: read("date-field"),
      ...exportRange(read("period"), this.pick("from").value, this.pick("through").value),
      content: read("content"), fields, include_metadata: this.pick("metadata").checked,
    };
  }

  async open() {
    if (!(await this.flushEditors())) return;
    this.generation++;
    const current = this.getFilters();
    this.pick("filters").reset();
    this.kinds = new Set(current.kind ? [current.kind] : []);
    this.relabel();
    for (const [name, value] of Object.entries({language:current.language || "", status:"", "date-field":"created_at", period:"all", content:"notes"}))
      this.pickers[name].setValue(value);
    this.pick("search").value = current.keyword || "";
    this.preview = null;
    this.showStep(false);
    this.reflect();
    openDialog(this.root);
  }

  showStep(formats) {
    this.pick("filters").hidden = formats;
    this.pick("formats").hidden = !formats;
    this.root.querySelector(".export-feedback").textContent = "";
    enter(this.pick(formats ? "formats" : "filters"), 5, 180);
    if (this.root.open) (formats ? this.pick("selection-title") : this.pickers.language.button).focus({preventScroll:true});
  }

  renderPreview() {
    this.pick("selection-title").textContent = this.t("exportSelection", {count:this.preview.count});
    const label = {notes:"exportFullNotes", terms:"exportTermsOnly", sections:"exportChooseSections"}[this.prepared.content];
    const fieldLabels = {meaning:"exportMeaning", explanation:"explanation", examples:"examples", translations:"exportTranslations", context:"context", corrected_sentence:"corrected"};
    this.pick("selection-content").textContent = this.prepared.content === "sections"
      ? this.prepared.fields.map(field => this.t(fieldLabels[field])).join(" · ") : this.t(label);
    this.pick("selection-preview").textContent = this.preview.titles.join(" · ") + (this.preview.count > this.preview.titles.length ? " …" : "");
  }

  async next() {
    const generation = ++this.generation;
    this.pick("next").disabled = true;
    this.root.querySelector(".export-feedback").textContent = "";
    try {
      this.prepared = this.selection();
      const preview = await this.api("exports/preview", this.prepared);
      if (generation !== this.generation || !this.root.open) return;
      if (!preview.count) throw new Error("exportEmpty");
      this.preview = preview;
      this.renderPreview();
      this.showStep(true);
    } catch (error) { this.feedback(".export-feedback", this.errorKey(error), true); }
    finally { this.pick("next").disabled = false; }
  }
}
