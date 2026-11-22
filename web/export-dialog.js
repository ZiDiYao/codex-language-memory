import { Picker } from "./picker.js";
import { enter, openDialog } from "./motion.js";
import { DateRange } from "./date-range.js";
import { localDate, exportRange } from "./export-model.js";
import { sceneLabel, sceneSelection } from "./scene-model.js";

/** Keep export choices separate from the history view until a file is requested. */
export class ExportDialog {
  constructor(root, helpers) {
    this.root = root;
    Object.assign(this, helpers);
    this.kinds = new Set();
    this.sceneCatalog = [];
    this.sceneVersion = 0;
    this.generation = 0;
    this.pick = (id) => root.querySelector(`#export-${id}`);
    this.pickers = {};
    for (const name of ["language", "status", "scene"]) {
      this.pickers[name] = new Picker(this.pick(name), {
        label: name, onChange: () => {
          this.generation++;
          if (name === "language") this.refreshSceneScope();
          else this.loadHistory();
        },
      });
    }
    this.dates = new DateRange(this.pick("range"), {
      t: this.t, getLocale: this.getLocale, onChange: () => {
        this.generation++;
        this.updateNextState();
      },
    });
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
    this.renderScenes();
    this.renderKinds();
    this.dates.render();
    this.renderHistory();
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
        this.refreshSceneScope();
        host.querySelectorAll("button")[["", "word", "expression", "grammar"].indexOf(kind)].focus();
      });
      return button;
    }));
  }

  renderScenes() {
    const picker = this.pickers.scene;
    const choices = this.sceneCatalog.map(({ name, count }) => ({ value: name, label: sceneLabel(name, this.t), count }));
    // Retain an inherited scene while its scoped choices are still loading.
    if (picker.value && !choices.some(({ value }) => value === picker.value))
      choices.unshift({ value: picker.value, label: sceneLabel(picker.value, this.t) });
    picker.setLabel(this.t("scene"));
    picker.setOptions([{ value: "", label: this.t("allScenes") }, ...choices]);
    picker.button.disabled = !!this.sceneLoading;
  }

  updateNextState() {
    this.pick("next").disabled = !!this.sceneLoading || Boolean(this.dates.from && !this.dates.through);
  }

  loadScenes() {
    const version = ++this.sceneVersion;
    const language = this.pickers.language.value || null;
    const kinds = this.kinds.size ? [...this.kinds] : [null];
    this.sceneLoading = true;
    this.sceneLoadError = null;
    this.historyVersion = (this.historyVersion || 0) + 1;
    this.history = null;
    this.historyState = "exportHistoryLoading";
    this.renderHistory();
    this.renderScenes();
    this.updateNextState();
    const pending = (async () => {
      try {
        const catalogs = await Promise.all(kinds.map((kind) => this.api("scenes/list", {
          language, kind, include_variants: true,
        })));
        if (version !== this.sceneVersion) return false;
        const counts = new Map();
        for (const { scenes } of catalogs) for (const { name, count } of scenes)
          counts.set(name, (counts.get(name) || 0) + count);
        this.sceneCatalog = [...counts].map(([name, count]) => ({ name, count }));
        this.sceneCatalog.sort((a, b) => a.name.localeCompare(b.name));
        this.pickers.scene.setValue(sceneSelection(this.sceneCatalog, this.pickers.scene.value));
        return true;
      } catch (error) {
        if (version !== this.sceneVersion) return false;
        this.sceneLoadError = error;
        throw error;
      } finally {
        if (version === this.sceneVersion) {
          this.sceneLoading = false;
          this.renderScenes();
          this.updateNextState();
        }
      }
    })();
    this.sceneRequest = pending;
    return pending;
  }

  async refreshSceneScope() {
    const generation = this.generation;
    try {
      if (await this.loadScenes()) await this.loadHistory();
    } catch (error) {
      if (generation === this.generation && this.root.open)
        this.feedback(".export-feedback", this.errorKey(error), true);
    }
  }

  scope() {
    return {
      language: this.pickers.language.value || null, status: this.pickers.status.value || null,
      scene: this.pickers.scene.value || null,
      include_variants: true, kinds: this.kinds.size ? [...this.kinds] : null,
      date_field: "created_at", content: "notes", include_metadata: false,
    };
  }

  selection() {
    if (Boolean(this.dates.from) !== Boolean(this.dates.through)) throw new Error("exportDateInvalid");
    return {...this.scope(), ...exportRange(this.dates.from ? "custom" : "all", this.dates.from, this.dates.through)};
  }

  async loadHistory() {
    const version = this.historyVersion = (this.historyVersion || 0) + 1;
    this.history = null; this.historyState = "exportHistoryLoading"; this.renderHistory();
    try {
      const response = await this.api("exports/history", this.scope());
      if (version !== this.historyVersion) return;
      this.history = response.last_export;
      this.historyState = "exportNoHistory";
    } catch {
      if (version !== this.historyVersion) return;
      this.historyState = "exportHistoryError";
    }
    this.renderHistory();
  }

  renderHistory() {
    const receipt = this.history;
    this.dates.marker = receipt ? localDate(new Date(Date.parse(receipt.through_at) - 1)) : null;
    let cutoff;
    if (receipt) {
      const end = new Date(receipt.through_at);
      const wholeDay = !end.getHours() && !end.getMinutes() && !end.getSeconds() && !end.getMilliseconds();
      cutoff = wholeDay ? this.dates.dayLabel(this.dates.marker)
        : new Intl.DateTimeFormat(this.getLocale(), {dateStyle:"medium", timeStyle:"short"}).format(end);
    }
    this.pick("history-title").textContent = receipt
      ? this.t("exportLastThrough", {day:cutoff})
      : this.t(this.historyState || "exportNoHistory");
    const detail = this.pick("history-detail");
    detail.hidden = !receipt;
    if (receipt) {
      const start = receipt.start_at ? this.dates.dayLabel(localDate(new Date(receipt.start_at))) : this.t("exportBeginning");
      detail.textContent = this.t("exportHistoryDetail", {from:start, count:receipt.count, format:receipt.format.toUpperCase()});
    }
    this.dates.render();
  }

  async open() {
    if (!(await this.flushEditors())) return;
    this.generation++;
    const current = this.getFilters();
    this.pick("filters").reset();
    this.kinds = new Set(current.kind ? [current.kind] : []);
    this.relabel();
    for (const [name, value] of Object.entries({language:current.language || "", status:"", scene:current.scene || ""}))
      this.pickers[name].setValue(value);
    this.renderScenes();
    this.preview = null;
    this.dates.reset();
    this.dates.close();
    this.pick("next").disabled = false;
    this.showStep(false);
    openDialog(this.root);
    await this.refreshSceneScope();
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
    this.pick("selection-range").textContent = [this.dates.summary(),
      this.prepared.scene && sceneLabel(this.prepared.scene, this.t)].filter(Boolean).join(" · ");
    this.pick("selection-preview").textContent = this.preview.titles.join(" · ") + (this.preview.count > this.preview.titles.length ? " …" : "");
  }

  async next() {
    const generation = ++this.generation;
    this.pick("next").disabled = true;
    this.root.querySelector(".export-feedback").textContent = "";
    try {
      if (this.sceneLoadError) await this.loadScenes();
      else if (this.sceneRequest) await this.sceneRequest;
      if (generation !== this.generation || !this.root.open) return;
      this.prepared = this.selection();
      const preview = await this.api("exports/preview", this.prepared);
      if (generation !== this.generation || !this.root.open) return;
      if (!preview.count) throw new Error("exportEmpty");
      this.preview = preview;
      this.renderPreview();
      this.showStep(true);
    } catch (error) {
      if (generation === this.generation && this.root.open)
        this.feedback(".export-feedback", this.errorKey(error), true);
    }
    finally { if (generation === this.generation) this.updateNextState(); }
  }
}
