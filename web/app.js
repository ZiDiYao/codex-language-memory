import { messages } from "./i18n.js";
import { Picker } from "./picker.js";
import { enter, reveal, conceal, openDialog, closeDialog, disclosure } from "./motion.js";

import { EntryEditor } from "./entry-editor.js";
import { RecordFeed } from "./record-feed.js";
import { languageSelection } from "./history-model.js";
import { ExportDialog } from "./export-dialog.js";
import { request, saveDownload } from "./transport.js";

const $ = (selector) => document.querySelector(selector);
const pageSize = 20;
let locale = "en";
let settings;
let catalog = { languages: [], counts: {}, kinds: {}, by_language: {} };
let ready = false;
let versions;
let syncing = false;
let settingsRevision = 0;
let settingsWrites = Promise.resolve();
let pendingSettingWrites = 0;
let settingsWriteError;
let noticeTimer;
const displayed = new Map();
const editors = new Map();
let selectedLanguage = "";
let selectedKind = "";
let switchingFilters = false;
const historyFeed = new RecordFeed({
  fetchPage: (args) => api("points/query", args),
  canCommit: ({ preserve }) => !hasDirtyEditors() && !(preserve && historyIsInteracting()),
  onStart: beginHistoryLoad,
  onCommit: renderRecords,
  onError: failHistoryLoad,
  onFinish: finishHistoryLoad,
});

function t(key, params = {}) {
  return messages[locale][key].replace(/\{(\w+)\}/g, (_, name) => {
    if (name === "date")
      return params.date
        ? new Date(params.date).toLocaleDateString(locale)
        : messages[locale].never;
    return String(params[name]);
  });
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function translated(tag, key, params = {}, className) {
  const node = element(tag, t(key, params), className);
  node.dataset.i18n = key;
  node.dataset.params = JSON.stringify(params);
  return node;
}
function languageName(code) {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code);
  } catch {
    return code;
  }
}
const languagePicker = new Picker($("#language"), {
  label: "Learning language",
  onChange: (value) => changeFilter("language", value),
});
const localePicker = new Picker($("#ui-language"), {
  label: "Interface language",
  value: locale,
  options: Object.entries(messages).map(([value, strings]) => ({
    value,
    label: strings.nativeName,
  })),
  onChange: (ui_language) => saveSettings({ ui_language }),
});
localePicker.button.disabled = true;
const firstLanguagePicker = new Picker($("#first-language"), {
  label: "First language",
  onChange: (first_language) => saveSettings({ first_language: first_language || null }),
});
const explanationLanguagePicker = new Picker($("#explanation-language"), {
  label: "Explanation language",
  onChange: (explanation_language) => saveSettings({ explanation_language: explanation_language || null }),
});
const exportDialog = new ExportDialog($("#export-dialog"), {
  t, api, languageName, download, flushEditors, feedback, errorKey,
  getFilters: filters, getCatalog: () => catalog, getLocale: () => locale,
});

function renderLanguagePreferences() {
  const codes = [...new Set(["en", "zh", "ja", "ko", "fr", "es", ...catalog.languages,
    settings?.first_language, settings?.explanation_language].filter(Boolean))];
  const options = codes.map((value) => ({ value, label: languageName(value) }));
  firstLanguagePicker.setLabel(t("firstLanguage"));
  firstLanguagePicker.setOptions([{ value: "", label: t("chooseFirstLanguage") }, ...options]);
  firstLanguagePicker.setValue(settings?.first_language || "");
  explanationLanguagePicker.setLabel(t("explanationLanguage"));
  explanationLanguagePicker.setOptions([{ value: "", label: t("useFirstLanguage") }, ...options]);
  explanationLanguagePicker.setValue(settings?.explanation_language || "");
}

function renderCatalog() {
  const selection = languageSelection(catalog.counts, selectedLanguage);
  selectedLanguage = selection.value;
  languagePicker.setLabel(t("notebook"));
  languagePicker.setOptions(selection.languages.map((code) => ({
    value: code, label: languageName(code), count: catalog.counts[code],
  })));
  languagePicker.setValue(selectedLanguage);
  languagePicker.button.disabled = selection.languages.length === 0;
}
function renderKinds() {
  const nav = $("#kinds");
  const restoreFocus = nav.contains(document.activeElement);
  nav.setAttribute("aria-label", t("kind"));
  nav.replaceChildren(...["", "word", "expression", "grammar"].map((kind) => {
    const button = element("button", t(kind || "all"), "type-tab");
    button.type = "button";
    button.setAttribute("aria-pressed", String(kind === selectedKind));
    button.addEventListener("click", () => changeFilter("kind", kind));
    return button;
  }));
  if (restoreFocus) nav.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
}
async function changeFilter(name, value) {
  if (switchingFilters) {
    languagePicker.setValue(selectedLanguage);
    return;
  }
  if (value === (name === "language" ? selectedLanguage : selectedKind)) return;
  switchingFilters = true;
  try {
    if (!(await flushEditors())) {
      languagePicker.setValue(selectedLanguage);
      return;
    }
    if (name === "language") selectedLanguage = value;
    else selectedKind = value;
    renderCatalog();
    renderKinds();
    await loadRecords(true);
  } finally { switchingFilters = false; }
}
async function flushEditors() {
  for (const editor of editors.values()) {
    if (!(await editor.flush())) {
      editor.card.open = true;
      editor.node.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return false;
    }
  }
  return true;
}
function applyLocale() {
  document.documentElement.lang = locale;
  document.title = t("appTitle");
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(
      node.dataset.i18n,
      JSON.parse(node.dataset.params || "{}"),
    );
  });
  document.querySelectorAll("[data-placeholder]").forEach((node) => {
    node.placeholder = t(node.dataset.placeholder);
  });
  document.querySelectorAll("[data-tooltip]").forEach((node) => {
    node.title = t(node.dataset.tooltip);
  });
  document.querySelectorAll(".entry-status-group").forEach((node) => {
    node.setAttribute("aria-label", t("status"));
  });
  document.querySelectorAll("[data-language]").forEach((node) => {
    node.textContent = languageName(node.dataset.language);
  });
  localePicker.setLabel(t("uiLanguage"));
  localePicker.setValue(locale);
  renderCatalog();
  renderKinds();
  renderLanguagePreferences();
  refreshEditorLocales();
  exportDialog.relabel();
}
function refreshEditorLocales() {
  for (const editor of editors.values()) {
    if (editor.uiLocale === locale || editor.dirty || editor.node.contains(document.activeElement)) continue;
    const old = editor.node;
    editor.node = editor.render();
    editor.uiLocale = locale;
    old.replaceWith(editor.node);
  }
}
function notice(key, error = false, params = {}) {
  clearTimeout(noticeTimer);
  const node = $("#notice");
  node.dataset.i18n = key;
  node.dataset.params = JSON.stringify(params);
  node.textContent = t(key, params);
  node.className = error ? "error" : "";
  reveal(node);
  if (!error && !["saving", "exporting"].includes(key))
    noticeTimer = setTimeout(() => {
      conceal(node);
    }, 3200);
}
function feedback(selector, key, error = false) {
  const node = $(selector);
  node.dataset.i18n = key;
  node.textContent = t(key);
  node.classList.toggle("error", error);
}
async function api(action, arguments_ = {}) {
  const response = await request("api", { action, arguments: arguments_ });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      messages[locale][data.error]
        ? data.error
        : response.status === 400
          ? "invalid"
          : "unavailable",
    );
  if (data.status === "failed" || data.status === "not_found")
    throw new Error(
      data.error === "identity_conflict" ? "conflict" : data.error === "edit_conflict" ? "editConflict" : data.status === "not_found" ? "notFound" : "invalid",
    );
  return data;
}
function errorKey(error) {
  return messages[locale][error.message] ? error.message : "unavailable";
}
function showError(error) {
  notice(errorKey(error), true);
}
function filters() {
  const result = { include_variants: true };
  for (const [key, value] of Object.entries({
    keyword: $("#search").value.trim(),
    language: selectedLanguage,
    kind: selectedKind,
  })) {
    if (value) result[key] = value;
  }
  return result;
}
function renderSettings() {
  $("#enabled").checked = settings.enabled;
  document.querySelectorAll('[name="enabled-type"]').forEach((input) => {
    input.checked = settings.enabled_types.includes(input.value);
  });
  const badge = $("#recording-badge");
  badge.dataset.i18n = settings.enabled ? "active" : "paused";
  badge.textContent = t(badge.dataset.i18n);
  $("#settings-fields").disabled = false;
  renderLanguagePreferences();
}
function card(record, expanded = false) {
  const details = element("details", undefined, "history-entry");
  details.dataset.id = record.id;
  details.open = expanded;
  const summary = element("summary");
  const body = element("div", undefined, "entry-body");
  const heading = element("div", undefined, "entry-heading");
  const title = element("h3");
  const mastery = element("div", undefined, "entry-status-group");
  mastery.setAttribute("role", "group");
  mastery.setAttribute("aria-label", t("status"));
  const statusButtons = ["new", "mastered"].map((status) => {
    const button = translated("button", status, {}, "entry-status");
    button.type = "button";
    button.dataset.status = status;
    return button;
  });
  mastery.append(...statusButtons);
  const preview = element("p", undefined, "entry-preview");
  const lastSeen = translated("small", "lastSeen", { date: record.last_seen_at }, "entry-last-seen");
  heading.append(title, mastery, element("span", undefined, "entry-chevron"));
  summary.append(heading, preview, lastSeen);
  function renderSummary(point) {
    const fullTitle = point.note_title || t("untitledNote");
    title.textContent = fullTitle;
    title.title = fullTitle;
    title.lang = point.language;
    summary.setAttribute("aria-label", fullTitle);
    statusButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.status === point.status));
    });
    preview.textContent = point.note_preview;
    preview.hidden = !point.note_preview;
  }
  renderSummary(record);
  const editor = new EntryEditor(record, {
    t, api, languageName, uiLocale: locale, card: details,
    onChange: (updated) => { displayed.set(updated.id, updated); renderSummary(updated); },
    onDeleted: async (deleted) => {
      editors.delete(deleted.id);
      displayed.delete(deleted.id);
      details.remove();
      catalog = await api("languages/list");
      renderCatalog();
      await loadRecords(true, true);
      notice("deleted");
    },
  });
  statusButtons.forEach((button) => button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const restoreFocus = document.activeElement === button;
    statusButtons.forEach((control) => { control.disabled = true; });
    try {
      if (!(await editor.setStatus(button.dataset.status))) details.open = true;
    } finally {
      statusButtons.forEach((control) => { control.disabled = false; });
      if (restoreFocus && document.activeElement === document.body) button.focus({ preventScroll: true });
    }
  }));
  editors.set(record.id, editor);
  body.append(editor.node);
  details.append(summary, body);
  disclosure(details, summary, body, (open) => {
    if (open) editor.node.querySelectorAll("textarea").forEach((input) => editor.resize(input));
  }, () => editor.flush());
  return details;
}
function updateLoadState(key, params = {}) {
  $("#load-sentinel").hidden = key === "allLoaded";
  const node = $("#load-state");
  node.dataset.i18n = key;
  node.dataset.params = JSON.stringify(params);
  node.textContent = t(key, params);
}
function hasDirtyEditors() {
  return [...editors.values()].some((editor) => editor.dirty);
}
function historyIsInteracting() {
  return document.querySelector(".history-entry[data-animating]") ||
    document.activeElement?.closest(".entry-editor");
}
function captureHistoryView(reset, preserve) {
  const anchor = preserve
    ? [...$("#records").children].find((node) => node.getBoundingClientRect().top >= 0)
    : null;
  return {
    reset, preserve,
    expanded: new Set(preserve
      ? [...document.querySelectorAll(".history-entry[open]")].map((node) => node.dataset.id) : []),
    anchorId: anchor?.dataset.id,
    anchorTop: anchor?.getBoundingClientRect().top,
  };
}
function clearRecords() {
  displayed.clear();
  editors.clear();
  $("#records").replaceChildren();
}
function renderRecords(data, { reset, preserve, expanded, anchorId, anchorTop }) {
  if (reset) clearRecords();
  const added = [];
  for (const record of data.records) {
    if (displayed.has(record.id)) continue;
    displayed.set(record.id, record);
    const node = card(record, expanded.has(String(record.id)));
    $("#records").append(node);
    added.push(node);
  }
  if (!displayed.size) {
    const empty = element("div", undefined, "empty");
    empty.append(translated("strong", "emptyTitle"), translated("p", "emptyHelp"));
    $("#records").append(empty);
  }
  if (!preserve) {
    if (reset) enter($("#records"), 5);
    else added.forEach((node) => enter(node, 4));
  }
  updateLoadState(data.has_more ? "scrollMore" : "allLoaded", { count: displayed.size });
  if (anchorId) {
    const restored = [...$("#records").children].find((node) => node.dataset.id === anchorId);
    if (restored) window.scrollBy(0, restored.getBoundingClientRect().top - anchorTop);
  }
}
function beginHistoryLoad({ reset, preserve }) {
  $("#retry-load").hidden = true;
  updateLoadState("loading");
  $("#records").setAttribute("aria-busy", "true");
  $("#records").classList.toggle("is-filtering", reset && !preserve);
}
function failHistoryLoad(error) {
  if (error.message === "notFound" && !hasDirtyEditors()) clearRecords();
  updateLoadState(errorKey(error));
  $("#retry-load").hidden = false;
}
function finishHistoryLoad() {
  $("#records").removeAttribute("aria-busy");
  $("#records").classList.remove("is-filtering");
  if (!historyFeed.failed) requestAnimationFrame(maybeLoadMore);
}
function maybeLoadMore() {
  if (ready && !historyFeed.loading && !historyFeed.failed && historyFeed.hasMore &&
      $("#load-sentinel").getBoundingClientRect().top < window.innerHeight + 250) {
    loadRecords();
  }
}
async function loadRecords(reset = false, preserve = false) {
  if (!ready) return false;
  if (reset && !preserve && !(await flushEditors())) return false;
  if (preserve && (hasDirtyEditors() || historyIsInteracting())) return false;
  return historyFeed.load({
    reset,
    amount: preserve ? Math.max(pageSize, displayed.size) : pageSize,
    filters: filters(),
    view: captureHistoryView(reset, preserve),
  });
}
async function loadSettings() {
  const revision = settingsRevision;
  await settingsWrites;
  const result = await api("settings/read");
  if (revision !== settingsRevision) return;
  settings = result;
  locale = settings.ui_language;
  renderSettings();
  applyLocale();
}
function saveSettings(patch) {
  ++settingsRevision;
  if (pendingSettingWrites === 0) settingsWriteError = null;
  ++pendingSettingWrites;
  feedback(".settings-feedback", "saving");
  settingsWrites = settingsWrites.then(async () => {
    try {
      settings = await api("settings/update", patch);
    } catch (error) {
      settingsWriteError = error;
      try {
        settings = await api("settings/read");
      } catch {
        /* Keep the last confirmed state. */
      }
    } finally {
      --pendingSettingWrites;
      if (pendingSettingWrites === 0) {
        locale = settings.ui_language;
        renderSettings();
        applyLocale();
        feedback(
          ".settings-feedback",
          settingsWriteError ? errorKey(settingsWriteError) : "settingsSaved",
          !!settingsWriteError,
        );
      }
    }
  });
}
async function synchronize() {
  if (!ready || syncing || historyFeed.loading || document.visibilityState === "hidden")
    return;
  syncing = true;
  try {
    refreshEditorLocales();
    const latest = await api("changes/read");
    if (latest.content !== versions.content) {
      catalog = await api("languages/list");
      renderCatalog();
      if (await loadRecords(true, true)) versions.content = latest.content;
    }
    if (latest.preferences !== versions.preferences && !pendingSettingWrites) {
      await loadSettings();
      versions.preferences = latest.preferences;
    }
  } catch (error) {
    showError(error);
  } finally {
    syncing = false;
  }
}
async function download(format, selection) {
  if (!(await flushEditors())) return;
  const buttons = [...document.querySelectorAll("[data-format], #export-back")];
  buttons.forEach((button) => {
    button.disabled = true;
  });
  feedback(".export-feedback", "exporting");
  try {
    const response = await request("export", { format, ...selection });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error);
    }
    await saveDownload(response);
    await closeDialog($("#export-dialog"));
    notice("exported", false, {
      count: response.headers.get("X-Record-Count"),
    });
  } catch (error) {
    feedback(".export-feedback", errorKey(error), true);
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}
$("#enabled").addEventListener("change", (event) =>
  saveSettings({ enabled: event.target.checked }),
);
document.querySelectorAll('[name="enabled-type"]').forEach((input) =>
  input.addEventListener("change", () => {
    saveSettings({
      enabled_types: [
        ...document.querySelectorAll('[name="enabled-type"]:checked'),
      ].map((node) => node.value),
    });
  }),
);
$("#settings-open").addEventListener("click", async () => {
  if (!(await flushEditors())) return;
  openDialog($("#settings-dialog"));
  try {
    await loadSettings();
  } catch (error) {
    feedback(".settings-feedback", errorKey(error), true);
  }
});
$("#export-open").addEventListener("click", () => exportDialog.open());
document
  .querySelectorAll(".dialog-close")
  .forEach((button) =>
    button.addEventListener("click", () => closeDialog(button.closest("dialog"))),
  );
document.querySelectorAll("dialog").forEach((dialog) =>
  dialog.addEventListener("click", (event) => {
    const rect = dialog.getBoundingClientRect();
    if (
      event.target === dialog &&
      (event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom)
    )
      closeDialog(dialog);
  }),
);
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog(dialog);
  });
});
$("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  clearTimeout(searchTimer);
  loadRecords(true);
});
let searchTimer;
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadRecords(true), 250);
});
$("#retry-load").addEventListener("click", () => {
  loadRecords(true);
});
new IntersectionObserver(maybeLoadMore, { rootMargin: "250px" }).observe(
  $("#load-sentinel"),
);
window.addEventListener("beforeunload", (event) => {
  if (hasDirtyEditors()) { event.preventDefault(); event.returnValue = ""; }
});
document.addEventListener("visibilitychange", synchronize);
window.addEventListener("focus", synchronize);
setInterval(synchronize, 3000);
applyLocale();
async function initialize() {
  try {
    [settings, catalog, versions] = await Promise.all([
      api("settings/read"),
      api("languages/list"),
      api("changes/read"),
    ]);
    locale = settings.ui_language;
    renderSettings();
    applyLocale();
    localePicker.button.disabled = false;
    ready = true;
    await loadRecords(true);
    if (!settings.first_language) openDialog($("#settings-dialog"));
  } catch (error) {
    showError(error);
  }
}
initialize();
