import { messages } from "./i18n.js";

const $ = (selector) => document.querySelector(selector);
const statusKeys = ["new", "learning", "mastered"];
const pageSize = 20;
let locale = "en";
let settings;
let catalog = { languages: ["en", "zh", "ja", "ko"], counts: {} };
let selectedLanguage;
let offset = 0;
let queryVersion = 0;
let settingsRevision = 0;
let settingsWrites = Promise.resolve();
let pendingSettingWrites = 0;
let settingsWriteError;

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

function applyLocale() {
  document.documentElement.lang = locale;
  document.title = t("appTitle");
  $("nav").setAttribute("aria-label", t("appTitle"));
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
    if (node.dataset.count !== undefined)
      node.textContent += " · " + node.dataset.count;
  });
  $("#ui-language").value = locale;
}

function notice(key, error = false) {
  const node = $("#notice");
  node.dataset.i18n = key;
  node.textContent = t(key);
  node.className = error ? "error" : "";
  node.hidden = false;
}

async function api(action, arguments_ = {}) {
  let response;
  try {
    response = await fetch("api", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Language-Memory": "1" },
      body: JSON.stringify({ action, arguments: arguments_ }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("disconnected");
  }
  if (!response.ok)
    throw new Error(response.status === 400 ? "invalid" : "unavailable");
  const data = await response.json();
  if (data.status === "failed" || data.status === "not_found") {
    throw new Error(
      data.error === "identity_conflict" ? "conflict" : "notFound",
    );
  }
  return data;
}

function showError(error) {
  notice(messages[locale][error.message] ? error.message : "unavailable", true);
}

function languageLabel(code) {
  const span = element("span", languageName(code));
  span.dataset.language = code;
  return span;
}

function renderNotebookOptions() {
  const bases = [
    ...new Set([
      "en",
      "zh",
      "ja",
      "ko",
      ...catalog.languages.map((code) => code.split("-")[0]),
    ]),
  ];
  const options = bases.map((code) => {
    const option = element(
      "option",
      languageName(code) + " · " + (catalog.counts[code] || 0),
    );
    option.value = code;
    option.dataset.language = code;
    option.dataset.count = catalog.counts[code] || 0;
    return option;
  });
  const all = translated("option", "allLanguages");
  all.value = "";
  $("#language").replaceChildren(...options, all);
  if (selectedLanguage === undefined) {
    selectedLanguage = Object.keys(catalog.counts)[0] || "en";
  }
  $("#language").value = selectedLanguage;
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

function field(form, key, value, tag = "textarea") {
  const label = element("label");
  const input = element(tag);
  input.value = value || "";
  input.maxLength = tag === "input" ? 350 : 2000;
  label.append(translated("span", key), input);
  form.append(label);
  return input;
}

function card(record) {
  const details = element("details", undefined, "card");
  const summary = element("summary");
  const heading = element("div", undefined, "card-heading");
  const kind = element("span", undefined, "kind");
  kind.append(
    translated("span", record.kind),
    element("span", " · "),
    languageLabel(record.language),
  );
  const titleNode = element("h3", record.title);
  titleNode.lang = record.language;
  heading.append(titleNode, kind);
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
  body.append(translated("h4", "sense"), element("p", record.sense_key));
  for (const example of record.examples) {
    const block = element("div", undefined, "example");
    const sentence = element("p", example.text);
    sentence.lang = record.language;
    block.append(sentence);
    if (example.translation)
      block.append(element("small", example.translation));
    body.append(block);
  }
  const dates = element("div", undefined, "meta");
  dates.append(
    translated("span", "created", { date: record.created_at }),
    translated("span", "reviewed", { date: record.last_reviewed_at }),
  );
  body.append(dates);
  const form = element("form");
  const fields = element("fieldset");
  const grid = element("div", undefined, "edit-grid");
  const title = field(grid, "title", record.title, "input");
  title.required = true;
  const meaning = field(grid, "meaning", record.meaning);
  meaning.required = true;
  const context = field(grid, "context", record.context);
  const explanation = field(grid, "explanation", record.explanation);
  let correction;
  if (record.kind === "correction")
    correction = field(grid, "corrected", record.corrected_sentence);
  const statusLabel = element("label");
  const status = element("select");
  for (const key of statusKeys) {
    const option = translated("option", key);
    option.value = key;
    status.append(option);
  }
  status.value = record.status;
  statusLabel.append(translated("span", "status"), status);
  grid.append(statusLabel);
  const actions = element("div", undefined, "actions");
  const save = translated("button", "saveChanges", {}, "primary");
  save.type = "submit";
  const remove = translated("button", "delete", {}, "danger");
  remove.type = "button";
  actions.append(save, remove);
  const deletePrompt = element("div", undefined, "actions");
  deletePrompt.hidden = true;
  const confirm = translated("button", "confirmDelete", {}, "danger");
  confirm.type = "button";
  const cancel = translated("button", "cancel");
  cancel.type = "button";
  deletePrompt.append(translated("span", "deleteQuestion"), confirm, cancel);
  remove.addEventListener("click", () => {
    deletePrompt.hidden = false;
  });
  cancel.addEventListener("click", () => {
    deletePrompt.hidden = true;
  });
  confirm.addEventListener("click", async () => {
    fields.disabled = true;
    try {
      await api("points/delete", { record_id: record.id });
      notice("deleted");
      catalog = await api("languages/list");
      renderNotebookOptions();
      await loadRecords();
    } catch (error) {
      showError(error);
    } finally {
      fields.disabled = false;
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = {
      title: title.value.trim(),
      meaning: meaning.value.trim(),
      context: context.value.trim() || null,
      explanation: explanation.value.trim() || null,
      status: status.value,
    };
    if (correction) values.corrected_sentence = correction.value.trim() || null;
    const patch = Object.fromEntries(
      Object.entries(values).filter(([key, value]) => value !== record[key]),
    );
    if (!Object.keys(patch).length) return;
    fields.disabled = true;
    try {
      await api("points/update", { record_id: record.id, patch });
      notice("saved");
      await loadRecords();
    } catch (error) {
      showError(error);
    } finally {
      fields.disabled = false;
    }
  });
  fields.append(grid, actions, deletePrompt);
  form.append(fields);
  body.append(form);
  details.append(body);
  return details;
}

async function loadRecords() {
  const version = ++queryVersion;
  $("#records").setAttribute("aria-busy", "true");
  try {
    const args = { limit: pageSize, offset, include_variants: true };
    for (const [key, selector] of Object.entries({
      keyword: "#search",
      kind: "#kind",
      status: "#status",
      language: "#language",
    })) {
      const value = $(selector).value.trim();
      if (value) args[key] = value;
    }
    const data = await api("points/query", args);
    if (version !== queryVersion) return;
    if (!data.records.length && offset > 0) {
      offset = Math.max(0, offset - pageSize);
      return loadRecords();
    }
    $("#records").replaceChildren(...data.records.map(card));
    if (!data.records.length) {
      const empty = element("div", undefined, "empty");
      empty.append(
        translated("strong", "emptyTitle"),
        translated("p", "emptyHelp"),
      );
      $("#records").append(empty);
    }
    $("#previous").disabled = offset === 0;
    $("#next").disabled = !data.has_more;
    $("#page-number").replaceChildren(
      translated("span", "page", { number: offset / pageSize + 1 }),
    );
  } catch (error) {
    if (version === queryVersion) showError(error);
  } finally {
    if (version === queryVersion) $("#records").removeAttribute("aria-busy");
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
  notice("saving");
  // Serialize writes so rapid clicks reach SQLite in their original order.
  settingsWrites = settingsWrites.then(async () => {
    try {
      settings = await api("settings/update", patch);
    } catch (error) {
      settingsWriteError = error;
      // A failed response can still have committed. Read back before restoring controls.
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
        if (settingsWriteError) showError(settingsWriteError);
        else notice("settingsSaved");
      }
    }
  });
}

$("#ui-language").addEventListener("change", (event) => {
  saveSettings({ ui_language: event.target.value });
});
$("#enabled").addEventListener("change", (event) => {
  saveSettings({ enabled: event.target.checked });
});
document.querySelectorAll('[name="enabled-type"]').forEach((input) => {
  input.addEventListener("change", () => {
    const enabled_types = [
      ...document.querySelectorAll('[name="enabled-type"]:checked'),
    ].map((checkbox) => checkbox.value);
    saveSettings({ enabled_types });
  });
});
$("#settings-form").addEventListener("submit", (event) =>
  event.preventDefault(),
);

function showPanel(name) {
  for (const panel of ["records", "settings"]) {
    const selected = panel === name;
    $("#" + panel + "-panel").hidden = !selected;
    if (selected) $("#" + panel + "-tab").setAttribute("aria-current", "page");
    else $("#" + panel + "-tab").removeAttribute("aria-current");
  }
}
$("#records-tab").addEventListener("click", () => {
  showPanel("records");
  loadRecords();
});
$("#settings-tab").addEventListener("click", async () => {
  showPanel("settings");
  try {
    await loadSettings();
  } catch (error) {
    showError(error);
  }
});
$("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  offset = 0;
  loadRecords();
});
for (const selector of ["#kind", "#status", "#language"]) {
  $(selector).addEventListener("change", () => {
    selectedLanguage = $("#language").value;
    offset = 0;
    loadRecords();
  });
}
$("#refresh").addEventListener("click", async () => {
  try {
    catalog = await api("languages/list");
    renderNotebookOptions();
    await loadSettings();
    await loadRecords();
  } catch (error) {
    showError(error);
  }
});
$("#previous").addEventListener("click", () => {
  offset -= pageSize;
  loadRecords();
});
$("#next").addEventListener("click", () => {
  offset += pageSize;
  loadRecords();
});

$("#ui-language").replaceChildren(
  ...Object.entries(messages).map(([code, translations]) => {
    const option = element("option", translations.nativeName);
    option.value = code;
    return option;
  }),
);
applyLocale();
$("#ui-language").disabled = true;
async function initialize() {
  try {
    [settings, catalog] = await Promise.all([
      api("settings/read"),
      api("languages/list"),
    ]);
    locale = settings.ui_language;
    renderSettings();
    renderNotebookOptions();
    applyLocale();
    $("#ui-language").disabled = false;
    await loadRecords();
  } catch (error) {
    showError(error);
  }
}
initialize();
