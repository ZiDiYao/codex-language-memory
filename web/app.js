import { messages } from "./i18n.js";
import { Picker } from "./picker.js";
import { enter, enterResults, reveal, conceal, openDialog, closeDialog, disclosure } from "./motion.js";

import { EntryEditor } from "./entry-editor.js";
import { RecordFeed } from "./record-feed.js";
import { languageSelection, enrichmentSummary } from "./history-model.js";
import { sceneSelection, sceneLabel } from "./scene-model.js";
import { ExportDialog } from "./export-dialog.js";
import { request, saveDownload, capabilities, openExternal, setAccountEpoch } from "./transport.js";
import { createLocalProfile, accountCanRead } from "./local-profile.js";
import { PronunciationController } from "./pronunciation.js";
import { ActivityController, isStudyClick } from "./activity.js";
import { createActivityView } from "./activity-view.js";
import { createLearningInstructionsEditor } from "./learning-instructions.js";
import { HistoryPosition, historyFilterKey } from "./history-position.js";

const $ = (selector) => document.querySelector(selector);
const pageSize = 20;
const available = capabilities();
const runtime = globalThis.languageMemoryRuntime;
const localAccount = !runtime && $("#local-profile-open");
let localProfile;
let accountPaused = false;
let accountDraftBlocked = false;
let sourceRevision = 0;
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
const activityRoot = $("[data-activity-view]");
const activityView = activityRoot ? createActivityView(activityRoot, {
  getLanguage: () => locale,
  onYearChange: (year) => activity.selectYear(year),
}) : null;
const activity = new ActivityController({
  request: (action, args) => api(action, args),
  canUse: () => ready && settings?._capabilities?.activity === true && !accountPaused && !accountDraftBlocked && !runtime?.isPaused?.(),
  onData: (data) => activityView?.render(data),
  onLoading: (loading) => activityView?.loading(loading),
  onError: (error) => activityView?.error(error),
  onClear: (options) => activityView?.clear(options),
});
let speechButton;
let speechActivityPhase;
const pronunciation = new PronunciationController({
  sourceMode: globalThis.languageMemoryHost ? "data" : "blob",
  canPlay: () => speechAvailable() && !accountPaused && !accountDraftBlocked && !runtime?.isPaused?.(),
  requestAudio: async (recordId) => {
    const source = sourceRevision;
    const response = await request("audio", { record_id: recordId });
    if (source !== sourceRevision) throw new Error("accountSuperseded");
    return response;
  },
  onState(state) {
    if (state?.phase === "playing" && speechActivityPhase !== "playing") activity.record("pronunciation");
    speechActivityPhase = state?.phase;
    if (speechButton) {
      speechButton.setAttribute("aria-pressed", "false");
      speechButton.removeAttribute("aria-busy");
      speechButton.classList.remove("is-speaking");
    }
    speechButton = state ? editors.get(state.recordId)?.card.querySelector(".entry-listen") : null;
    if (speechButton) {
      speechButton.setAttribute("aria-pressed", String(state.phase !== "ready"));
      speechButton.setAttribute("aria-busy", String(state.phase === "loading"));
      speechButton.classList.toggle("is-speaking", state.phase === "playing");
    }
    if (state?.phase === "playing" && $("#notice").dataset.i18n === "speechTapToPlay") conceal($("#notice"));
  },
  onDiagnostic(diagnostic) {
    if (!speechButton) return;
    speechButton.dataset.speechStage = diagnostic.stage;
    speechButton.dataset.speechEngine = diagnostic.engine;
    if (diagnostic.errorName) speechButton.dataset.speechError = diagnostic.errorName;
    else delete speechButton.dataset.speechError;
    if (diagnostic.mediaCode) speechButton.dataset.speechMediaCode = String(diagnostic.mediaCode);
    else delete speechButton.dataset.speechMediaCode;
  },
  onError(error) {
    if (["cloud_not_connected", "account_changed"].includes(error.message)) localProfile?.session.refresh();
    if (error.message === "speechTapToPlay") { notice("speechTapToPlay"); return; }
    showError(error);
  },
});
function speechAvailable() { return available.speech && settings?._capabilities?.cloud_speech === true; }
function renderSpeechAvailability() {
  const enabled = speechAvailable();
  if (!enabled) pronunciation.stop();
  document.querySelectorAll(".entry-listen").forEach((button) => {
    button.hidden = !enabled;
    button.closest(".entry-heading").classList.toggle("without-speech", !enabled);
  });
}
let selectedLanguage = "";
let selectedKind = "";
let selectedStatus = "";
let committedFiltersKey = null;
let selectedScene = "";
let sceneCatalog = [];
let sceneCatalogVersion = 0;
let switchingFilters = false;
let resumingHistory = false;
let historyResumeRequested = false;
let historyInteractionVersion = 0;
let historySaveTimer;
const historyFeed = new RecordFeed({
  fetchPage: (args) => api("points/query", args),
  canCommit: ({ preserve, filtersKey, restorePlan }) => !accountPaused && filtersKey === JSON.stringify(filters()) &&
    (!restorePlan || restorePlan.isCurrent()) &&
    !hasDirtyEditors() && !(preserve && historyIsInteracting()),
  onStart: beginHistoryLoad,
  onCommit: renderRecords,
  onError: failHistoryLoad,
  onFinish: finishHistoryLoad,
});
const historyPosition = new HistoryPosition({
  storage: runtime?.historyStorage ?? {
    read: (args) => api("history/view/read", args),
    write: (args) => api("history/view/write", args),
  },
  getFilters: filters,
  capture: captureHistoryPosition,
  restore: restoreHistoryPosition,
  canUse: () => ready && !accountPaused && !accountDraftBlocked && !runtime?.isPaused?.() && !$("main").hidden,
});
const historyLifecycle = {
  save: () => historyPosition.save(),
  flush: () => historyPosition.flush(),
  resume: () => requestHistoryResume(),
  invalidate: () => historyPosition.invalidate(),
};
globalThis.sayroveHistoryLifecycle = historyLifecycle;

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
const scenePicker = new Picker($("#scene"), {
  label: "Scene",
  onChange: (value) => changeFilter("scene", value),
});
const statusPicker = !runtime ? new Picker($("#status"), {
  label: "Learning status",
  onChange: (value) => changeFilter("status", value),
}) : null;
$("#status").hidden = !statusPicker;
$(".history-selectors").classList.toggle("has-status-filter", !!statusPicker);
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
const learningInstructions = createLearningInstructionsEditor($("#learning-instructions"), { save: saveSettings, t });
const exportDialog = new ExportDialog($("#export-dialog"), {
  t, api, languageName, download, flushEditors, feedback, errorKey,
  getFilters: filters, getCatalog: () => catalog, getLocale: () => locale,
});
$("#export-open").hidden = !available.export;

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
    button.dataset.studyActivity = "";
    button.type = "button";
    button.setAttribute("aria-pressed", String(kind === selectedKind));
    button.addEventListener("click", () => changeFilter("kind", kind));
    return button;
  }));
  if (restoreFocus) nav.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
}
function renderScenes() {
  scenePicker.setLabel(t("scene"));
  scenePicker.setOptions([{ value: "", label: t("allScenes") }, ...sceneCatalog.map(({ name, count }) => ({
    value: name, label: sceneLabel(name, t), count,
  }))]);
  scenePicker.setValue(selectedScene);
  scenePicker.button.title = selectedScene ? sceneLabel(selectedScene, t) : t("allScenes");
  scenePicker.button.disabled = !sceneCatalog.length;
}
function renderStatus() {
  if (!statusPicker) return;
  statusPicker.setLabel(t("status"));
  statusPicker.setOptions([["", "allStatuses"], ["new", "new"], ["mastered", "mastered"]]
    .map(([value, key]) => ({ value, label: t(key) })));
  statusPicker.setValue(selectedStatus);
}
async function loadScenes(preserve = false) {
  const version = ++sceneCatalogVersion;
  const scope = { include_variants: true };
  if (selectedLanguage) scope.language = selectedLanguage;
  if (selectedKind) scope.kind = selectedKind;
  const result = await api("scenes/list", scope);
  if (version !== sceneCatalogVersion || (scope.language || "") !== selectedLanguage ||
      (scope.kind || "") !== selectedKind) return false;
  if (preserve && (hasDirtyEditors() || historyIsInteracting() || switchingFilters)) return false;
  sceneCatalog = result.scenes;
  selectedScene = sceneSelection(sceneCatalog, selectedScene);
  renderScenes();
  return true;
}
async function changeFilter(name, value) {
  cancelHistoryRestore();
  if (switchingFilters) {
    languagePicker.setValue(selectedLanguage);
    scenePicker.setValue(selectedScene);
    statusPicker?.setValue(selectedStatus);
    return;
  }
  if (value === ({ language: selectedLanguage, kind: selectedKind, scene: selectedScene, status: selectedStatus })[name]) return;
  const previous = { language: selectedLanguage, kind: selectedKind, scene: selectedScene, status: selectedStatus };
  switchingFilters = true;
  try {
    if (!(await flushEditors())) {
      languagePicker.setValue(selectedLanguage);
      scenePicker.setValue(selectedScene);
      statusPicker?.setValue(selectedStatus);
      return;
    }
    if (name === "language") selectedLanguage = value;
    else if (name === "kind") selectedKind = value;
    else if (name === "status") selectedStatus = value;
    else selectedScene = value;
    renderCatalog();
    renderKinds();
    renderScenes();
    renderStatus();
    if (name === "language" || name === "kind") await loadScenes();
    await loadRecords(true, false, { animateFilterChange: !runtime });
  } catch (error) {
    selectedLanguage = previous.language;
    selectedKind = previous.kind;
    selectedScene = previous.scene;
    selectedStatus = previous.status;
    renderCatalog();
    renderKinds();
    renderScenes();
    renderStatus();
    showError(error);
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
async function flushLearningInstructions() {
  if (await learningInstructions.flush()) return true;
  openDialog($("#settings-dialog"));
  $("#learning-instructions").open = true;
  $("#english-learning-instructions").focus();
  return false;
}
if (runtime) {
  runtime.activity = activity;
  runtime.stopPronunciation = () => pronunciation.stop();
  runtime.invalidateLearningInstructions = () => learningInstructions.invalidate();
  runtime.saveHistoryPosition = historyLifecycle.save;
  runtime.invalidateHistoryPosition = historyLifecycle.invalidate;
  runtime.beforeAccountChange = async () => {
    if (!(await flushEditors()) || !(await flushLearningInstructions())) return false;
    await historyPosition.flush();
    pronunciation.stop();
    activity.invalidate();
    return true;
  };
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
  document.querySelectorAll(".entry-listen").forEach((node) => {
    node.setAttribute("aria-label", `${t("listen")} (${t("pronunciationDisclosure")})`);
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
  renderScenes();
  renderLanguagePreferences();
  renderStatus();
  refreshEditorLocales();
  exportDialog?.relabel();
  localProfile?.relabel();
  activity.relabel();
  learningInstructions.relabel();
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
  if (accountDraftBlocked && !action.startsWith("account/")) throw new Error("account_changed");
  const source = sourceRevision;
  const response = await request("api", { action, arguments: arguments_ });
  const data = await response.json();
  if (!action.startsWith("account/") && source !== sourceRevision) throw new Error("accountSuperseded");
  if (!action.startsWith("account/") && (data.error === "cloud_not_connected" || data.error === "account_changed"))
    localProfile?.session.refresh();
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
  if (error.message === "accountSuperseded") return;
  notice(errorKey(error), true);
}
function filters() {
  const result = { include_variants: true };
  for (const [key, value] of Object.entries({
    keyword: $("#search").value.trim(),
    language: selectedLanguage,
    kind: selectedKind,
    scene: selectedScene,
    status: selectedStatus,
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
  learningInstructions.load(settings);
  renderSpeechAvailability();
}
function card(record, expanded = false) {
  const details = element("details", undefined, "history-entry");
  details.dataset.id = record.id;
  details.open = expanded;
  const summary = element("summary");
  summary.dataset.studyActivity = "";
  const body = element("div", undefined, "entry-body");
  body.dataset.studyActivity = "";
  const heading = element("div", undefined, "entry-heading");
  const title = element("h3");
  const listenButton = element("button", undefined, "icon-button entry-listen");
  listenButton.type = "button";
  listenButton.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4zM15 8c2 2 2 6 0 8M18 5c4 4 4 10 0 14"/></svg>';
  listenButton.setAttribute("aria-label", `${t("listen")} (${t("pronunciationDisclosure")})`);
  listenButton.setAttribute("aria-pressed", "false");
  listenButton.dataset.tooltip = "pronunciationDisclosure";
  listenButton.title = t("pronunciationDisclosure");
  listenButton.hidden = !speechAvailable();
  listenButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    pronunciation.toggle(record.id);
  });
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
  const enrichment = element("small", undefined, "entry-enrichment");
  enrichment.setAttribute("role", "status");
  const lastSeen = translated("small", "lastSeen", { date: record.last_seen_at }, "entry-last-seen");
  if (!speechAvailable()) heading.classList.add("without-speech");
  heading.append(title, listenButton, mastery, element("span", undefined, "entry-chevron"));
  summary.append(heading, preview, enrichment, lastSeen);
  function renderSummary(point) {
    const presentation = enrichmentSummary(point);
    const fullTitle = presentation.title || t("untitledNote");
    title.textContent = fullTitle;
    title.title = fullTitle;
    title.lang = point.language;
    summary.setAttribute("aria-label", fullTitle);
    statusButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.status === point.status));
    });
    preview.textContent = point.note_preview;
    preview.hidden = !point.note_preview;
    enrichment.hidden = !presentation.messageKey;
    if (presentation.messageKey) {
      enrichment.dataset.i18n = presentation.messageKey;
      enrichment.textContent = t(presentation.messageKey);
    } else {
      delete enrichment.dataset.i18n;
      enrichment.textContent = "";
    }
  }
  renderSummary(record);
  const editor = new EntryEditor(record, {
    t, api, languageName, uiLocale: locale, card: details,
    onChange: (updated) => { pronunciation.stop(updated.id); displayed.set(updated.id, updated); renderSummary(updated); },
    onDeleted: async (deleted) => {
      pronunciation.stop(deleted.id);
      editors.get(deleted.id)?.dispose();
      editors.delete(deleted.id);
      displayed.delete(deleted.id);
      details.remove();
      catalog = await api("languages/list");
      renderCatalog();
      await loadRecords(true, true);
      notice("deleted");
    },
  });
  editor.node.dataset.studyActivity = "";
  statusButtons.forEach((button) => button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const restoreFocus = document.activeElement === button;
    statusButtons.forEach((control) => { control.disabled = true; });
    try {
      if (!(await editor.setStatus(button.dataset.status))) details.open = true;
      else if (selectedStatus && editor.record.status !== selectedStatus) await loadRecords(true, true);
    } finally {
      statusButtons.forEach((control) => { control.disabled = false; });
      if (restoreFocus && document.activeElement === document.body)
        (button.isConnected ? button : statusPicker?.button)?.focus({ preventScroll: true });
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
    filtersSnapshot: { ...filters() },
    filtersKey: JSON.stringify(filters()),
    expanded: new Set(preserve
      ? [...document.querySelectorAll(".history-entry[open]")].map((node) => node.dataset.id) : []),
    anchorId: anchor?.dataset.id,
    anchorTop: anchor?.getBoundingClientRect().top,
  };
}
function captureHistoryPosition() {
  const cards = [...document.querySelectorAll("#records > .history-entry")];
  const anchor = cards.find((node) => node.getBoundingClientRect().bottom > 0);
  return {
    anchor_id: anchor ? Number(anchor.dataset.id) : null,
    anchor_top: anchor?.getBoundingClientRect().top ?? 0,
    scroll_y: Math.max(0, window.scrollY),
    loaded_count: Math.max(1, Math.min(2000, displayed.size)),
    expanded_ids: cards.filter((node) => node.open).map((node) => Number(node.dataset.id)).slice(0, 100),
  };
}
async function restoreHistoryPosition(plan) {
  if (!plan.isCurrent() || hasDirtyEditors() || historyIsInteracting() || document.querySelector("dialog[open]")) return false;
  if (plan.initial && plan.state) {
    selectedLanguage = plan.filters.language ?? "";
    selectedKind = plan.filters.kind ?? "";
    selectedScene = plan.filters.scene ?? "";
    selectedStatus = plan.filters.status ?? "";
    $("#search").value = plan.filters.keyword ?? "";
    renderSearchClear();
    renderCatalog(); renderKinds(); renderStatus();
    await loadScenes();
    if (!plan.isCurrent()) return false;
  }
  const contentChanged = plan.contentVersion !== undefined && plan.contentVersion !== versions.content;
  if (!plan.initial && contentChanged) {
    const nextCatalog = await api("languages/list");
    if (!plan.isCurrent()) return false;
    catalog = nextCatalog;
    renderCatalog();
    if (!(await loadScenes(true)) || !plan.isCurrent()) return false;
  }
  const reload = plan.initial || plan.toTop || contentChanged || !displayed.size ||
    historyFilterKey(historyPosition.activeFilters) !== historyFilterKey(filters());
  if (reload) {
    const loaded = await loadRecords(true, false, { restorePlan: plan,
      amount: plan.toTop ? pageSize : Math.min(2000, Math.max(pageSize, plan.state?.view.loaded_count ?? pageSize)) });
    if (!loaded || !plan.isCurrent()) return false;
    if (plan.contentVersion !== undefined) versions.content = plan.contentVersion;
  }
  // Notes size themselves on the next frame. Restore after that layout work.
  for (const editor of editors.values()) if (editor.card.open)
    editor.card.querySelectorAll("textarea").forEach((input) => editor.resize(input));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (!plan.isCurrent()) return false;
  if (plan.toTop) window.scrollTo({ top: 0, behavior: "instant" });
  else if (plan.state) {
    const node = editors.get(plan.state.view.anchor_id)?.card;
    if (node) window.scrollBy({ top: node.getBoundingClientRect().top - plan.state.view.anchor_top, behavior: "instant" });
    else window.scrollTo({ top: plan.state.view.scroll_y, behavior: "instant" });
  }
  return true;
}
function cancelHistoryRestore() {
  ++historyInteractionVersion;
  historyResumeRequested = false;
  historyPosition.cancelRestore();
}
async function requestHistoryResume() {
  historyResumeRequested = true;
  if (!ready || accountPaused || runtime?.isPaused?.() || document.visibilityState === "hidden" ||
      syncing || resumingHistory || historyFeed.loading) return;
  if (hasDirtyEditors() || historyIsInteracting() || document.querySelector("dialog[open]")) {
    historyResumeRequested = false;
    return;
  }
  historyResumeRequested = false;
  resumingHistory = true;
  const source = sourceRevision;
  const interaction = historyInteractionVersion;
  try {
    const latest = await api("changes/read");
    if (source !== sourceRevision || interaction !== historyInteractionVersion) return;
    historyPosition.observe(latest.latest_point_id);
    await historyPosition.resume({ contentVersion: latest.content });
  } catch { /* View bookkeeping must not block the library. */ }
  finally {
    resumingHistory = false;
    if (historyResumeRequested) void requestHistoryResume();
    else void synchronize();
    requestAnimationFrame(maybeLoadMore);
  }
}
function clearRecords() {
  pronunciation.stop();
  for (const editor of editors.values()) editor.dispose();
  displayed.clear();
  editors.clear();
  $("#records").replaceChildren();
}
function renderRecords(data, { reset, preserve, expanded, anchorId, anchorTop, filtersKey, filtersSnapshot, animateFilterChange, restorePlan }) {
  const host = $("#records");
  if (reset) {
    const incoming = new Map(data.records.map((record) => [record.id, record]));
    for (const [id, previous] of displayed) {
      const next = incoming.get(id);
      if (next && JSON.stringify(previous) === JSON.stringify(next)) continue;
      pronunciation.stop(id);
      const editor = editors.get(id);
      editor?.dispose();
      editor?.card.remove();
      editors.delete(id);
      displayed.delete(id);
    }
  }
  const added = [];
  if (data.records.length) host.querySelector(".empty")?.remove();
  let previousNode = null;
  for (const record of data.records) {
    let node = editors.get(record.id)?.card;
    if (!node) {
      displayed.set(record.id, record);
      node = card(record, expanded.has(String(record.id)));
      added.push(node);
    }
    if (reset) {
      const nextSlot = previousNode ? previousNode.nextSibling : host.firstChild;
      if (node !== nextSlot) host.insertBefore(node, nextSlot);
      previousNode = node;
    } else if (!node.isConnected) host.append(node);
  }
  if (!displayed.size && !host.querySelector(".empty")) {
    const empty = element("div", undefined, "empty");
    empty.append(translated("strong", "emptyTitle"), translated("p", "emptyHelp"));
    host.append(empty);
    added.push(empty);
  }
  // Explicit desktop filter switches also animate cards reused by both filters.
  if (!preserve && !restorePlan) enterResults(animateFilterChange ? [...host.children] : added);
  committedFiltersKey = filtersKey;
  historyPosition.committed(filtersSnapshot);
  updateLoadState(data.has_more ? "scrollMore" : "allLoaded", { count: displayed.size });
  if (anchorId) {
    const restored = [...$("#records").children].find((node) => node.dataset.id === anchorId);
    if (restored) window.scrollBy(0, restored.getBoundingClientRect().top - anchorTop);
  }
}
function beginHistoryLoad({ reset, preserve, restorePlan }) {
  if (reset && !preserve && !restorePlan) void historyPosition.save();
  $("#retry-load").hidden = true;
  if (!reset || !$("#records").children.length) updateLoadState("loading");
  $("#records").setAttribute("aria-busy", "true");
}
function failHistoryLoad(error) {
  if (error.message === "notFound" && !hasDirtyEditors()) clearRecords();
  updateLoadState(errorKey(error));
  $("#retry-load").hidden = false;
}
function finishHistoryLoad() {
  $("#records").removeAttribute("aria-busy");
  if (!historyFeed.failed) requestAnimationFrame(() => historyResumeRequested ? requestHistoryResume() : maybeLoadMore());
}
function maybeLoadMore() {
  if (ready && !accountPaused && !resumingHistory && !historyPosition.restoring && JSON.stringify(filters()) === committedFiltersKey &&
      !historyFeed.loading && !historyFeed.failed && historyFeed.hasMore &&
      $("#load-sentinel").getBoundingClientRect().top < window.innerHeight + 250) {
    loadRecords();
  }
}
async function loadRecords(reset = false, preserve = false, { animateFilterChange = false, restorePlan, amount } = {}) {
  if (!ready || accountPaused) return false;
  if (reset && !preserve && !(await flushEditors())) return false;
  if (preserve && (hasDirtyEditors() || historyIsInteracting())) return false;
  const previousFeed = { cursor: historyFeed.cursor, hasMore: historyFeed.hasMore, failed: historyFeed.failed };
  const reading = historyFeed.load({
    reset,
    amount: amount ?? (preserve ? Math.max(pageSize, displayed.size) : pageSize),
    filters: filters(),
    view: { ...captureHistoryView(reset, preserve), animateFilterChange, restorePlan,
      ...(restorePlan ? { requestCurrent: restorePlan.isCurrent } : {}),
      ...(restorePlan && !restorePlan.toTop && restorePlan.state ?
        { expanded: new Set(restorePlan.state.view.expanded_ids.map(String)) } : {}) },
  });
  const requestVersion = historyFeed.version;
  const loaded = await reading;
  if (restorePlan && !loaded && !restorePlan.isCurrent() && requestVersion === historyFeed.version)
    Object.assign(historyFeed, previousFeed);
  return loaded;
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
  const source = sourceRevision;
  ++settingsRevision;
  if (pendingSettingWrites === 0) settingsWriteError = null;
  ++pendingSettingWrites;
  feedback(".settings-feedback", "saving");
  settingsWrites = settingsWrites.then(async () => {
    try {
      if (source !== sourceRevision) throw new Error("accountSuperseded");
      const confirmedCapabilities = settings?._capabilities;
      const updated = await api("settings/update", patch);
      if (Object.hasOwn(patch, "english_learning_instructions") && updated.english_learning_instructions !== patch.english_learning_instructions)
        throw new Error("learningInstructionsSaveFailed");
      settings = { ...updated, _capabilities: updated._capabilities ?? confirmedCapabilities };
      return settings;
    } catch (error) {
      if (source !== sourceRevision) return;
      settingsWriteError = error;
      try {
        settings = await api("settings/read");
      } catch {
        /* Keep the last confirmed state. */
      }
    } finally {
      --pendingSettingWrites;
      if (pendingSettingWrites === 0 && source === sourceRevision && settings) {
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
  return settingsWrites;
}
async function synchronize() {
  if (!ready || accountPaused || runtime?.isPaused?.() || syncing || resumingHistory || historyPosition.restoring || historyFeed.loading || document.visibilityState === "hidden")
    return;
  syncing = true;
  try {
    refreshEditorLocales();
    const latest = await api("changes/read");
    historyPosition.observe(latest.latest_point_id);
    if (latest.content !== versions.content) {
      if (hasDirtyEditors() || historyIsInteracting() || switchingFilters) return;
      const latestCatalog = await api("languages/list");
      if (hasDirtyEditors() || historyIsInteracting() || switchingFilters) return;
      catalog = latestCatalog;
      renderCatalog();
      if (!(await loadScenes(true))) return;
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
    if (historyResumeRequested) void requestHistoryResume();
  }
}
async function download(format, selection) {
  const source = sourceRevision;
  if (!(await flushEditors())) return;
  if (source !== sourceRevision || accountPaused || accountDraftBlocked) return;
  const buttons = [...document.querySelectorAll("[data-format], #export-back")];
  buttons.forEach((button) => {
    button.disabled = true;
  });
  feedback(".export-feedback", "exporting");
  try {
    const response = await request("export", { format, ...selection });
    if (source !== sourceRevision || accountPaused) return;
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error);
    }
    await saveDownload(response);
    if (source !== sourceRevision || accountPaused) return;
    await closeDialog($("#export-dialog"));
    notice("exported", false, {
      count: response.headers.get("X-Record-Count"),
    });
  } catch (error) {
    if (source !== sourceRevision) return;
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
$("#export-open").addEventListener("click", () => { if (available.export) exportDialog?.open(); });
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
  cancelHistoryRestore();
  event.preventDefault();
  clearTimeout(searchTimer);
  loadRecords(true);
});
let searchTimer;
function renderSearchClear() {
  $("#search-clear").hidden = !$("#search").value;
}
renderSearchClear();
$("#search").addEventListener("input", () => {
  cancelHistoryRestore();
  renderSearchClear();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadRecords(true), 250);
});
$("#search-clear").addEventListener("click", () => {
  clearTimeout(searchTimer);
  $("#search").value = "";
  renderSearchClear();
  $("#search").focus({ preventScroll: true });
  loadRecords(true);
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
window.addEventListener("pagehide", () => { void historyPosition.save(); pronunciation.stop(); activity.invalidate(); });
window.addEventListener("blur", () => { void historyPosition.save(); });
window.addEventListener("scroll", () => {
  clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(() => void historyPosition.save(), 180);
}, { passive: true });
for (const type of ["wheel", "touchstart", "pointerdown"]) window.addEventListener(type, cancelHistoryRestore, { passive: true });
window.addEventListener("keydown", (event) => {
  if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) &&
      !event.target.closest?.("input, textarea, [contenteditable], [role=combobox]")) cancelHistoryRestore();
});
document.querySelectorAll("#settings-open, #settings-fields, #ui-language, #language, #scene, #status, #search-clear, #retry-load")
  .forEach((node) => { node.dataset.studyActivity = ""; });
document.addEventListener("click", (event) => { if (isStudyClick(event)) activity.record("button"); }, { capture: true });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void historyPosition.save();
  else void requestHistoryResume();
});
window.addEventListener("focus", requestHistoryResume);
setInterval(synchronize, 3000);
applyLocale();
async function initialize(promptSettings = true) {
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
    historyPosition.observe(versions.latest_point_id);
    if (activityRoot?.closest("dialog")?.open) void activity.open();
    const interaction = historyInteractionVersion;
    await loadScenes();
    if (interaction !== historyInteractionVersion ||
        !(await historyPosition.resume({ initial: true, contentVersion: versions.content }))) await loadRecords(true);
    requestAnimationFrame(maybeLoadMore);
    if (promptSettings && !settings.first_language) openDialog($("#settings-dialog"));
  } catch (error) {
    showError(error);
  }
}
if (localAccount) {
  localProfile = createLocalProfile({
    root: document, t, openDialog, closeDialog, openExternal, activity,
    call: (action) => api(action),
    beforeChange: async () => {
      if (accountDraftBlocked || !(await flushEditors()) || !(await flushLearningInstructions())) return false;
      await settingsWrites;
      return !settingsWriteError;
    },
    onPause(paused) {
      const next = paused || accountDraftBlocked;
      if (next && !accountPaused) {
        ++sourceRevision;
        ++sceneCatalogVersion;
        ++historyFeed.version;
        historyFeed.loading = false;
        historyPosition.invalidate();
        clearTimeout(searchTimer);
        pronunciation.stop();
        activity.invalidate();
        learningInstructions.invalidate();
      }
      accountPaused = next;
      $("#records-panel").inert = next && !accountDraftBlocked;
      $("#settings-open").disabled = next;
      $("#export-open").disabled = next;
      if (accountDraftBlocked) {
        $("#records-panel").querySelectorAll("button, input").forEach((node) => { node.disabled = true; });
        $("#records-panel").querySelectorAll("textarea").forEach((node) => { node.readOnly = true; });
      }
    },
    async onSourceChange(status, previous) {
      historyPosition.invalidate();
      activity.invalidate();
      learningInstructions.invalidate();
      exportDialog.invalidate();
      setAccountEpoch(status.epoch);
      if (previous && hasDirtyEditors()) {
        accountDraftBlocked = true;
        localProfile.session.notify();
        const node = $("#local-account-notice");
        node.dataset.i18n = "accountChanged";
        node.textContent = t("accountChanged");
        node.hidden = false;
        return;
      }
      ++sourceRevision;
      ready = false;
      ++historyFeed.version;
      historyFeed.loading = false;
      historyFeed.failed = false;
      historyFeed.cursor = null;
      committedFiltersKey = null;
      clearRecords();
      $("#records").removeAttribute("aria-busy");
      settings = undefined;
      settingsWriteError = null;
      versions = undefined;
      catalog = { languages: [], counts: {}, kinds: {}, by_language: {} };
      sceneCatalog = [];
      selectedLanguage = selectedKind = selectedScene = selectedStatus = "";
      $("#search").value = "";
      renderSearchClear();
      $("#settings-fields").disabled = true;
      localePicker.button.disabled = true;
      renderCatalog(); renderKinds(); renderScenes(); renderStatus();
      Object.assign(available, { export: false, speech: true }, status.capabilities);
      $("#export-open").hidden = !available.export;
      if ($("#settings-dialog").open) closeDialog($("#settings-dialog"));
      if ($("#export-dialog").open) closeDialog($("#export-dialog"));
      const node = $("#local-account-notice");
      node.hidden = accountCanRead(status);
      node.dataset.i18n = status.state === "connecting" ? "accountConnecting" : "accountSignedOutHelp";
      node.textContent = t(node.dataset.i18n);
      const badge = $("#recording-badge");
      badge.dataset.i18n = status.state === "connecting" ? "connecting" : "accountSignedOut";
      badge.textContent = t(badge.dataset.i18n);
      $("#load-sentinel").hidden = !accountCanRead(status);
      if (accountCanRead(status)) await initialize(false);
    },
  });
  localProfile.session.notify();
  localProfile.session.refresh();
  window.addEventListener("focus", () => localProfile.session.refresh());
  window.addEventListener("pagehide", () => localProfile.session.dispose());
} else initialize();
