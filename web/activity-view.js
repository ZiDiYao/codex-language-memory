import { messages } from "./i18n.js";
import { Picker } from "./picker.js";

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
  if (!value || !Array.isArray(value.days)) throw new TypeError("Invalid activity period");
  const start = calendarDate(value.start_date), end = calendarDate(value.end_date);
  const annual = Number.isInteger(value.year);
  const today = calendarDate(value.today || (annual ? "" : value.end_date));
  const year = annual ? value.year : end.getUTCFullYear();
  if (annual ? year < 1970 || year > today.getUTCFullYear() || value.start_date !== `${year}-01-01` || value.end_date !== `${year}-12-31`
    : value.year != null || end - start !== 181 * DAY) throw new TypeError("Invalid activity period");
  if (value.days.length !== (end - start) / DAY + 1) throw new TypeError("Invalid activity period");
  if (typeof value.timezone !== "string" || value.timezone.length > 80) throw new TypeError("Invalid activity timezone");
  new Intl.DateTimeFormat("en", { timeZone: value.timezone });
  const availableYears = annual ? value.available_years : [year];
  if (!Array.isArray(availableYears) || !availableYears.length || availableYears.some((item, index) =>
    !Number.isInteger(item) || item < 1970 || item > today.getUTCFullYear() || (index > 0 && item >= availableYears[index - 1])))
    throw new TypeError("Invalid activity years");
  const days = new Map();
  for (const day of value.days) {
    const date = calendarDate(day?.date);
    if (date < start || date > end || days.has(day.date) || !count(day.learning_count) || !count(day.interaction_count) ||
        !Number.isInteger(day.score) || day.score < 0 || day.score > 100 || !Number.isInteger(day.level) || day.level < 0 || day.level > 4)
      throw new TypeError("Invalid activity day");
    const future = date > today;
    if (future && (day.learning_count || day.interaction_count || day.score || day.level)) throw new TypeError("Invalid future activity");
    days.set(day.date, { ...day, future });
  }
  const ordered = [];
  for (let at = start.getTime(); at <= end.getTime(); at += DAY) {
    const day = days.get(new Date(at).toISOString().slice(0, 10));
    if (!day) throw new TypeError("Missing activity day");
    ordered.push(day);
  }
  const cells = [...Array(start.getUTCDay()).fill(null), ...ordered];
  while (cells.length % 7) cells.push(null);
  const months = [];
  for (const [index, day] of ordered.entries()) {
    if (index === 0 || day.date.endsWith("-01")) months.push({ date: day.date, column: Math.floor((start.getUTCDay() + index) / 7) });
  }
  return { start, end, today, year, annual, availableYears, months, timezone: value.timezone, days: ordered, cells, columns: cells.length / 7,
    totals: ordered.filter((day) => !day.future).reduce((total, day) => ({ learning: total.learning + day.learning_count,
      interaction: total.interaction + day.interaction_count, active: total.active + Number(day.level > 0) }),
    { learning: 0, interaction: 0, active: 0 }) };
}

function localeFor(value) { return Object.hasOwn(messages, value) ? value : "en"; }
export function activityText(language, key, values = {}) {
  const locale = localeFor(language);
  return (messages[locale][key] || messages.en[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
}

/** One compact, accessible view for native, loopback and public-web profiles. */
export function createActivityView(root, { getLanguage = () => "en", onYearChange = () => {} } = {}) {
  if (!root) throw new TypeError("Activity view is missing");
  const $ = (name) => root.querySelector(`[data-activity-${name}]`);
  const grid = $("grid"), calendar = $("calendar"), range = $("range"), status = $("status"), detail = $("detail");
  const months = $("months"), weekdays = $("weekdays"), yearHost = $("year"), legend = $("legend");
  const retry = root.querySelector('[data-activity-action="retry"]');
  let model = null, labels = new Map(), yearChoices = [], annualNavigation = false;
  const text = (key, values) => activityText(getLanguage(), key, values);
  const number = (value) => new Intl.NumberFormat(localeFor(getLanguage())).format(value);
  const dateLabel = (value) => new Intl.DateTimeFormat(localeFor(getLanguage()), { dateStyle: "medium", timeZone: "UTC" }).format(calendarDate(value));
  const yearPicker = yearHost ? new Picker(yearHost, {
    label: text("activityYear"),
    onChange: (value) => { if (Number(value) !== model?.year) onYearChange(Number(value)); },
  }) : null;
  root.closest("dialog")?.addEventListener("close", () => yearPicker?.close());
  const busy = (value) => {
    root.setAttribute("aria-busy", String(value));
    if (value) yearPicker?.close();
    if (yearPicker) yearPicker.button.disabled = value || !annualNavigation || !yearChoices.length;
  };
  const showDetail = (label) => { detail.textContent = detail.title = label; };
  function showStatus(key, error = false) {
    status.textContent = key ? text(key) : "";
    status.hidden = !key;
    status.classList.toggle("error", error);
  }
  function showDay(node) {
    const label = labels.get(node?.dataset.activityDate);
    if (label) showDetail(label);
  }
  grid.addEventListener("pointerover", (event) => showDay(event.target.closest?.("[data-activity-date]")));
  grid.addEventListener("focusin", (event) => showDay(event.target.closest?.("[data-activity-date]")));
  grid.addEventListener("focusout", (event) => {
    if (!grid.contains(event.relatedTarget)) showDetail(text("activitySelectDay"));
  });
  grid.addEventListener("keydown", (event) => {
    const node = event.target.closest?.("[data-activity-date]");
    if (!node) return;
    const cells = [...grid.querySelectorAll("[data-activity-date]")].filter((cell) => !cell.disabled);
    if (node.disabled || !cells.length) return;
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
  function clear({ preserveYears = false, year } = {}) {
    model = null;
    labels = new Map();
    grid.replaceChildren();
    months?.replaceChildren();
    weekdays?.replaceChildren();
    yearPicker?.close();
    if (!preserveYears) {
      yearPicker?.setOptions([]);
      yearPicker?.setValue("");
      yearChoices = []; annualNavigation = false;
    } else if (Number.isInteger(year)) yearPicker?.setValue(String(year));
    calendar.hidden = range.hidden = true;
    range.textContent = "";
    showDetail(text("activitySelectDay"));
    showStatus("activityUnavailable");
    retry.hidden = true;
    busy(false);
  }
  function error(error) {
    busy(false);
    showStatus(error?.message === "activityYearUnavailable" ? "activityYearUnavailable" : "activityError", true);
    retry.hidden = false;
  }
  busy(false);
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
      const eligible = next.days.filter((day) => !day.future);
      const focusDate = eligible.some((day) => day.date === focused) ? focused : eligible.at(-1)?.date;
      for (const [position, day] of next.cells.entries()) {
        const cell = root.ownerDocument.createElement(day ? "button" : "span");
        if (!day) { cell.className = "activity-pad"; cell.setAttribute("aria-hidden", "true"); fragment.append(cell); continue; }
        const label = day.future ? text("activityFutureDay", { date: dateLabel(day.date) }) :
          text("activityDayDetail", { date: dateLabel(day.date), learning: number(day.learning_count),
            interactions: number(day.interaction_count), score: number(day.score) });
        labels.set(day.date, label);
        cell.type = "button";
        cell.className = "activity-cell";
        cell.dataset.activityDate = day.date;
        cell.dataset.position = String(position);
        cell.dataset.level = String(day.level);
        cell.disabled = day.future;
        if (day.future) { cell.dataset.future = "true"; cell.setAttribute("aria-disabled", "true"); }
        cell.tabIndex = day.date === focusDate ? 0 : -1;
        cell.title = label;
        cell.setAttribute("aria-label", label);
        fragment.append(cell);
      }
      grid.style.setProperty("--activity-columns", String(next.columns));
      calendar.style.setProperty("--activity-columns", String(next.columns));
      grid.replaceChildren(fragment);
      model = next;
      if (months) {
        const formatter = new Intl.DateTimeFormat(localeFor(getLanguage()), { month: "short", timeZone: "UTC" });
        const narrow = new Intl.DateTimeFormat(localeFor(getLanguage()), { month: "narrow", timeZone: "UTC" });
        months.replaceChildren(...next.months.map((month, index) => {
          const span = root.ownerDocument.createElement("span");
          const width = (next.months[index + 1]?.column ?? next.columns) - month.column;
          span.style.setProperty("grid-column", `${month.column + 1} / span ${Math.max(1, width)}`);
          span.title = formatter.format(calendarDate(month.date));
          for (const [format, className] of [[formatter, "activity-label-short"], [narrow, "activity-label-narrow"]]) {
            const label = root.ownerDocument.createElement("span");
            label.className = className;
            label.textContent = format.format(calendarDate(month.date));
            span.append(label);
          }
          return span;
        }));
      }
      if (weekdays) weekdays.replaceChildren(...Array.from({ length: 7 }, (_, index) => {
        const span = root.ownerDocument.createElement("span");
        if ([1, 3, 5].includes(index)) {
          for (const [format, className] of [["short", "activity-label-short"], ["narrow", "activity-label-narrow"]]) {
            const label = root.ownerDocument.createElement("span");
            label.className = className;
            label.textContent = new Intl.DateTimeFormat(localeFor(getLanguage()), { weekday: format, timeZone: "UTC" })
              .format(new Date(Date.UTC(2023, 0, 1 + index)));
            span.append(label);
          }
        }
        return span;
      }));
      if (yearPicker) {
        const years = [...new Set([next.year, ...next.availableYears])].sort((a, b) => b - a);
        yearChoices = years; annualNavigation = next.annual;
        yearPicker.setOptions(years.map((year) => ({ value: String(year), label: number(year).replace(/[,\s]/g, "") })));
        yearPicker.setValue(String(next.year));
        yearPicker.setLabel(text("activityYear"));
      }
      if (legend) legend.setAttribute("aria-label", text("activityLegendLabel"));
      range.textContent = `${dateLabel(value.start_date)} – ${dateLabel(value.end_date)} · ${value.timezone}`;
      range.hidden = next.annual;
      calendar.hidden = false;
      grid.setAttribute("aria-label", `${range.textContent}${next.annual ? "" : " · " + text("activityPartialYear")}`);
      showDetail(focused && labels.has(focused) ? labels.get(focused) : text("activitySelectDay"));
      showStatus(!next.annual ? "activityPartialYear" : next.totals.active ? null : "activityEmpty");
      retry.hidden = true;
      busy(false);
      if (focused && focusDate === focused) grid.querySelector(`[data-activity-date="${focused}"]`)?.focus({ preventScroll: true });
    },
  };
}
