import { messages } from "./i18n.js";
import { Picker } from "./picker.js";

const $ = (selector) => document.querySelector(selector);
const pageSize = 20;
let locale = "en";
let settings;
let catalog = { languages: ["en", "zh", "ja", "ko", "fr", "es"], counts: {} };
let cursor = null;
let hasMore = true;
let loading = false;
let loadFailed = false;
let queryVersion = 0;
let ready = false;
let versions;
let syncing = false;
let settingsRevision = 0;
let settingsWrites = Promise.resolve();
let pendingSettingWrites = 0;
let settingsWriteError;
let noticeTimer;
const displayed = new Map();

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
function typeOptions(keys) {
  return keys.map((key) => ({ value: key, label: t(key) }));
}
const languagePicker = new Picker($("#language"), {
  label: "Learning language",
  value: "en",
  onChange: () => loadRecords(true),
});
const kindPicker = new Picker($("#kind"), {
  label: "Type",
  onChange: () => loadRecords(true),
});
const statusPicker = new Picker($("#status"), {
  label: "Learning status",
  onChange: () => loadRecords(true),
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

function renderCatalog() {
  const bases = [
    ...new Set([
      "en",
      "zh",
      "ja",
      "ko",
      "fr",
      "es",
      ...catalog.languages.map((code) => code.split("-")[0]),
    ]),
  ];
  languagePicker.setOptions([
    {
      value: "",
      label: t("allLanguages"),
      count: Object.values(catalog.counts).reduce((a, b) => a + b, 0),
    },
    ...bases.map((code) => ({
      value: code,
      label: languageName(code),
      count: catalog.counts[code] || 0,
    })),
  ]);
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
  document.querySelectorAll("[data-language]").forEach((node) => {
    node.textContent = languageName(node.dataset.language);
  });
  languagePicker.setLabel(t("notebook"));
  kindPicker.setLabel(t("kind"));
  statusPicker.setLabel(t("status"));
  localePicker.setLabel(t("uiLanguage"));
  kindPicker.setOptions([
    { value: "", label: t("allTypes") },
    ...typeOptions(["word", "expression", "grammar", "correction"]),
  ]);
  statusPicker.setOptions([
    { value: "", label: t("allStatuses") },
    ...typeOptions(["new", "mastered"]),
  ]);
  localePicker.setValue(locale);
  renderCatalog();
}
function notice(key, error = false, params = {}) {
  clearTimeout(noticeTimer);
  const node = $("#notice");
  node.dataset.i18n = key;
  node.dataset.params = JSON.stringify(params);
  node.textContent = t(key, params);
  node.className = error ? "error" : "";
  node.hidden = false;
  if (!error && !["saving", "exporting"].includes(key))
    noticeTimer = setTimeout(() => {
      node.hidden = true;
    }, 4000);
}
function feedback(selector, key, error = false) {
  const node = $(selector);
  node.dataset.i18n = key;
  node.textContent = t(key);
  node.classList.toggle("error", error);
}
async function request(route, payload) {
  try {
    return await fetch(route, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Language-Memory": "1" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(route === "export" ? 60000 : 15000),
    });
  } catch {
    throw new Error("disconnected");
  }
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
      data.error === "identity_conflict" ? "conflict" : "notFound",
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
    language: languagePicker.value,
    kind: kindPicker.value,
    status: statusPicker.value,
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
}
function card(record) {
  const details = element("details", undefined, "card");
  details.dataset.id = record.id;
  const summary = element("summary");
  const heading = element("div", undefined, "card-heading");
  const kind = element("span", undefined, "kind");
  const language = element("span", languageName(record.language));
  language.dataset.language = record.language;
  kind.append(
    translated("span", record.kind),
    element("span", " · "),
    language,
  );
  const title = element("h3", record.title);
  title.lang = record.language;
  heading.append(title, kind);
  const meta = element("div", undefined, "meta");
  meta.append(
    translated("span", record.status),
    translated("span", "encounters", { count: record.encounter_count }),
    translated("span", "lastSeen", { date: record.last_seen_at }),
  );
  const disclosure = translated("span", "expand", {}, "disclosure");
  summary.append(
    heading,
    element("p", record.meaning, "meaning"),
    meta,
    disclosure,
  );
  details.append(summary);
  details.addEventListener("toggle", () => {
    disclosure.dataset.i18n = details.open ? "collapse" : "expand";
    disclosure.textContent = t(disclosure.dataset.i18n);
  });
  const body = element("div", undefined, "detail");
  for (const [key, value] of [
    ["explanation", record.explanation],
    ["context", record.context],
    ["corrected", record.corrected_sentence],
  ]) {
    if (value) body.append(translated("h4", key), element("p", value));
  }
  if (!record.content_ready)
    body.append(translated("p", "needsExplanation", {}, "help"));
  if (record.examples.length) body.append(translated("h4", "examples"));
  for (const example of record.examples) {
    const block = element("div", undefined, "example");
    const sentence = element("p", example.text);
    sentence.lang = record.language;
    block.append(sentence);
    if (example.translation)
      block.append(element("small", example.translation));
    body.append(block);
  }
  const dates = element("div", undefined, "meta detail-meta");
  dates.append(
    translated("span", "created", { date: record.created_at }),
    translated("span", "reviewed", { date: record.last_reviewed_at }),
  );
  body.append(dates);
  const actions = element("div", undefined, "actions");
  const mastery = translated(
    "button",
    record.status === "mastered" ? "keepLearning" : "markMastered",
  );
  const remove = translated("button", "delete", {}, "subtle");
  actions.append(mastery, remove);
  const confirmation = element("div", undefined, "actions");
  confirmation.hidden = true;
  const confirm = translated("button", "confirmDelete", {}, "danger");
  const cancel = translated("button", "cancel");
  confirmation.append(translated("span", "deleteQuestion"), confirm, cancel);
  remove.addEventListener("click", () => {
    confirmation.hidden = false;
  });
  cancel.addEventListener("click", () => {
    confirmation.hidden = true;
  });
  mastery.addEventListener("click", async () => {
    mastery.disabled = true;
    try {
      await api("points/update", {
        record_id: record.id,
        patch: {
          status: record.status === "mastered" ? "new" : "mastered",
        },
      });
      await loadRecords(true, true);
      notice("saved");
    } catch (error) {
      showError(error);
    } finally {
      mastery.disabled = false;
    }
  });
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    try {
      await api("points/delete", { record_id: record.id });
      await loadRecords(true, true);
      catalog = await api("languages/list");
      renderCatalog();
      notice("deleted");
    } catch (error) {
      showError(error);
    } finally {
      confirm.disabled = false;
    }
  });
  body.append(actions, confirmation);
  details.append(body);
  return details;
}
function updateLoadState(key, params = {}) {
  $("#load-sentinel").hidden = key === "allLoaded";
  const node = $("#load-state");
  node.dataset.i18n = key;
  node.dataset.params = JSON.stringify(params);
  node.textContent = t(key, params);
}
function maybeLoadMore() {
  if (
    ready &&
    !loading &&
    !loadFailed &&
    hasMore &&
    $("#load-sentinel").getBoundingClientRect().top < window.innerHeight + 250
  )
    loadRecords();
}
async function loadRecords(reset = false, preserve = false) {
  if (!ready || (!reset && (loading || !hasMore || loadFailed))) return;
  const version = reset ? ++queryVersion : queryVersion;
  const existing = [...document.querySelectorAll(".card")];
  const anchor = preserve
    ? existing.find((node) => node.getBoundingClientRect().top >= 0)
    : null;
  const anchorId = anchor?.dataset.id;
  const anchorTop = anchor?.getBoundingClientRect().top;
  const expanded = new Set(
    preserve
      ? existing.filter((node) => node.open).map((node) => node.dataset.id)
      : [],
  );
  const amount = preserve ? Math.max(pageSize, displayed.size) : pageSize;
  if (reset) {
    cursor = null;
    hasMore = true;
    loadFailed = false;
  }
  loading = true;
  $("#retry-load").hidden = true;
  updateLoadState("loading");
  if (!preserve && reset) {
    displayed.clear();
    $("#records").replaceChildren();
  }
  $("#records").setAttribute("aria-busy", "true");
  try {
    const args = { ...filters(), limit: amount };
    if (cursor) args.cursor = cursor;
    const data = await api("points/query", args);
    if (version !== queryVersion) return;
    if (reset) {
      displayed.clear();
      $("#records").replaceChildren();
    }
    for (const record of data.records) {
      if (displayed.has(record.id)) continue;
      displayed.set(record.id, record);
      const node = card(record);
      node.open = expanded.has(String(record.id));
      $("#records").append(node);
    }
    if (!displayed.size) {
      const empty = element("div", undefined, "empty");
      empty.append(
        translated("strong", "emptyTitle"),
        translated("p", "emptyHelp"),
      );
      $("#records").append(empty);
    }
    cursor = data.next_cursor;
    hasMore = data.has_more;
    updateLoadState(hasMore ? "scrollMore" : "allLoaded", {
      count: displayed.size,
    });
    if (anchorId) {
      const restored = [...document.querySelectorAll(".card")].find(
        (node) => node.dataset.id === anchorId,
      );
      if (restored)
        window.scrollBy(0, restored.getBoundingClientRect().top - anchorTop);
    }
  } catch (error) {
    if (version === queryVersion) {
      loadFailed = true;
      updateLoadState(errorKey(error));
      $("#retry-load").hidden = false;
    }
  } finally {
    if (version === queryVersion) {
      loading = false;
      $("#records").removeAttribute("aria-busy");
      if (!loadFailed) requestAnimationFrame(maybeLoadMore);
    }
  }
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
  if (!ready || syncing || loading || document.visibilityState === "hidden")
    return;
  syncing = true;
  try {
    const latest = await api("changes/read");
    if (latest.content !== versions.content) {
      catalog = await api("languages/list");
      renderCatalog();
      await loadRecords(true, true);
      if (!loadFailed) versions.content = latest.content;
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
async function download(format) {
  const buttons = [...document.querySelectorAll("[data-format]")];
  buttons.forEach((button) => {
    button.disabled = true;
  });
  feedback(".export-feedback", "exporting");
  try {
    const response = await request("export", { format, ...filters() });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error);
    }
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download =
      response.headers
        .get("Content-Disposition")
        ?.match(/filename="([^"]+)"/)?.[1] || "language-memory";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    $("#export-dialog").close();
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
  $("#settings-dialog").showModal();
  try {
    await loadSettings();
  } catch (error) {
    feedback(".settings-feedback", errorKey(error), true);
  }
});
$("#export-open").addEventListener("click", () => {
  $(".export-feedback").textContent = "";
  $("#export-dialog").showModal();
});
document
  .querySelectorAll(".dialog-close")
  .forEach((button) =>
    button.addEventListener("click", () => button.closest("dialog").close()),
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
      dialog.close();
  }),
);
document
  .querySelectorAll("[data-format]")
  .forEach((button) =>
    button.addEventListener("click", () => download(button.dataset.format)),
  );
$("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  loadRecords(true);
});
let searchTimer;
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadRecords(true), 250);
});
$("#retry-load").addEventListener("click", () => {
  loadFailed = false;
  loadRecords();
});
new IntersectionObserver(maybeLoadMore, { rootMargin: "250px" }).observe(
  $("#load-sentinel"),
);
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
  } catch (error) {
    showError(error);
  }
}
initialize();
