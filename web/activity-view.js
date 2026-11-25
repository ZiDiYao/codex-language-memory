import { messages } from "./i18n.js";

const DAY = 86400000;
function calendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError("Invalid activity date");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new TypeError("Invalid activity date");
  return date;
}
const count = (value) => Number.isSafeInteger(value) && value >= 0;

/** Calendar dates are already in the requested timezone. Never offset them again. */
export function activityCalendar(value) {
  if (!value || !Array.isArray(value.days) || value.days.length !== 182) throw new TypeError("Invalid activity period");
  const start = calendarDate(value.start_date), end = calendarDate(value.end_date);
  if (end - start !== 181 * DAY) throw new TypeError("Invalid activity period");
  if (typeof value.timezone !== "string" || value.timezone.length > 80) throw new TypeError("Invalid activity timezone");
  new Intl.DateTimeFormat("en", { timeZone: value.timezone });
  const days = new Map();
  for (const day of value.days) {
    const date = calendarDate(day?.date);
    if (date < start || date > end || days.has(day.date) || !count(day.learning_count) || !count(day.interaction_count) ||
        !Number.isInteger(day.score) || day.score < 0 || day.score > 100 || !Number.isInteger(day.level) || day.level < 0 || day.level > 4)
      throw new TypeError("Invalid activity day");
    days.set(day.date, { ...day });
  }
  const ordered = [];
  for (let at = start.getTime(); at <= end.getTime(); at += DAY) {
    const day = days.get(new Date(at).toISOString().slice(0, 10));
    if (!day) throw new TypeError("Missing activity day");
    ordered.push(day);
  }
  const cells = [...Array(start.getUTCDay()).fill(null), ...ordered];
  while (cells.length % 7) cells.push(null);
  return { start, end, timezone: value.timezone, days: ordered, cells, columns: cells.length / 7,
    totals: ordered.reduce((total, day) => ({ learning: total.learning + day.learning_count,
      interaction: total.interaction + day.interaction_count, active: total.active + Number(day.level > 0) }),
    { learning: 0, interaction: 0, active: 0 }) };
}

function localeFor(value) { return Object.hasOwn(messages, value) ? value : "en"; }
export function activityText(language, key, values = {}) {
  const locale = localeFor(language);
  return (messages[locale][key] || messages.en[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
}

/** One compact, accessible view for native, loopback and public-web profiles. */
export function createActivityView(root, { getLanguage = () => "en" } = {}) {
  if (!root) throw new TypeError("Activity view is missing");
  const $ = (name) => root.querySelector(`[data-activity-${name}]`);
  const grid = $("grid"), calendar = $("calendar"), range = $("range"), status = $("status"), detail = $("detail");
  const summary = $("summary"), help = $("help");
  const retry = root.querySelector('[data-activity-action="retry"]');
  const refresh = root.querySelector('[data-activity-action="refresh"]');
  let model = null, labels = new Map();
  const text = (key, values) => activityText(getLanguage(), key, values);
  const number = (value) => new Intl.NumberFormat(localeFor(getLanguage())).format(value);
  const dateLabel = (value) => new Intl.DateTimeFormat(localeFor(getLanguage()), { dateStyle: "medium", timeZone: "UTC" }).format(calendarDate(value));
  const busy = (value) => { root.setAttribute("aria-busy", String(value)); if (refresh) refresh.disabled = value; };
  function showStatus(key, error = false) {
    status.textContent = key ? text(key) : "";
    status.hidden = !key;
    status.classList.toggle("error", error);
  }
  function showDay(node) {
    const label = labels.get(node?.dataset.activityDate);
    if (label) detail.textContent = label;
  }
  grid.addEventListener("pointerover", (event) => showDay(event.target.closest?.("[data-activity-date]")));
  grid.addEventListener("focusin", (event) => showDay(event.target.closest?.("[data-activity-date]")));
  grid.addEventListener("focusout", (event) => {
    if (!grid.contains(event.relatedTarget)) detail.textContent = text("activitySelectDay");
  });
  grid.addEventListener("keydown", (event) => {
    const node = event.target.closest?.("[data-activity-date]");
    if (!node) return;
    const cells = [...grid.querySelectorAll("[data-activity-date]")];
    const current = Number(node.dataset.position);
    let position;
    if (event.key === "ArrowRight") position = current + 7;
    else if (event.key === "ArrowLeft") position = current - 7;
    else if (event.key === "ArrowDown" && current % 7 < 6) position = current + 1;
    else if (event.key === "ArrowUp" && current % 7 > 0) position = current - 1;
    else if (event.key === "Home") position = Number(cells[0].dataset.position);
    else if (event.key === "End") position = Number(cells.at(-1).dataset.position);
    else return;
    const target = cells.find((cell) => Number(cell.dataset.position) === position);
    event.preventDefault();
    if (!target) return;
    for (const cell of cells) cell.tabIndex = cell === target ? 0 : -1;
    target.focus({ preventScroll: true });
    showDay(target);
  });
  function clear() {
    model = null;
    labels = new Map();
    grid.replaceChildren();
    calendar.hidden = range.hidden = true;
    range.textContent = summary.textContent = "";
    detail.textContent = text("activitySelectDay");
    showStatus("activityUnavailable");
    retry.hidden = true;
    busy(false);
    if (refresh) refresh.disabled = true;
  }
  function error() {
    busy(false);
    showStatus("activityError", true);
    retry.hidden = false;
  }
  return {
    clear,
    loading(value = true) {
      busy(value);
      if (!value) return;
      showStatus(model ? "activityRefreshing" : "activityLoading");
      retry.hidden = true;
    },
    error,
    render(value) {
      let next;
      try { next = activityCalendar(value); }
      catch { error(); return; }
      const focused = grid.contains(root.ownerDocument.activeElement) ? root.ownerDocument.activeElement.dataset.activityDate : null;
      const fragment = root.ownerDocument.createDocumentFragment();
      labels = new Map();
      for (const [position, day] of next.cells.entries()) {
        const cell = root.ownerDocument.createElement(day ? "button" : "span");
        if (!day) { cell.className = "activity-pad"; cell.setAttribute("aria-hidden", "true"); fragment.append(cell); continue; }
        const label = text("activityDayDetail", { date: dateLabel(day.date), learning: number(day.learning_count),
          interactions: number(day.interaction_count), score: number(day.score) });
        labels.set(day.date, label);
        cell.type = "button";
        cell.className = "activity-cell";
        cell.dataset.activityDate = day.date;
        cell.dataset.position = String(position);
        cell.dataset.level = String(day.level);
        cell.tabIndex = day.date === (focused || value.end_date) ? 0 : -1;
        cell.title = label;
        cell.setAttribute("aria-label", label);
        fragment.append(cell);
      }
      grid.style.setProperty("--activity-columns", String(next.columns));
      grid.replaceChildren(fragment);
      model = next;
      range.textContent = `${dateLabel(value.start_date)} – ${dateLabel(value.end_date)} · ${value.timezone}`;
      range.hidden = calendar.hidden = false;
      summary.textContent = text("activitySummary", { days: number(next.totals.active), learning: number(next.totals.learning),
        interactions: number(next.totals.interaction) });
      detail.textContent = focused && labels.has(focused) ? labels.get(focused) : text("activitySelectDay");
      help.textContent = text("activityWeights");
      help.title = text("activityScoreHelp");
      showStatus(next.totals.active ? null : "activityEmpty");
      retry.hidden = true;
      busy(false);
      if (focused) grid.querySelector(`[data-activity-date="${focused}"]`)?.focus({ preventScroll: true });
    },
  };
}
