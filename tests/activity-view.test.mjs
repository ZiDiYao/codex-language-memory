import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
globalThis.matchMedia ??= () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
globalThis.getComputedStyle ??= () => ({ opacity: "1", transform: "none" });
const { activityCalendar, activityText, createActivityView } = await import("../web/activity-view.js");

function fixture(end = "2026-11-24") {
  const endAt = Date.parse(`${end}T00:00:00Z`), startAt = endAt - 181 * 86400000;
  const days = Array.from({ length: 182 }, (_, index) => ({
    date: new Date(startAt + index * 86400000).toISOString().slice(0, 10),
    learning_count: 0, interaction_count: 0, score: 0, level: 0,
  }));
  return { timezone: "America/Toronto", start_date: days[0].date, end_date: end, days,
    weights: { learning: .7, interaction: .3 }, targets: { learning: 5, interaction: 10 } };
}

function annual(year = 2026, today = "2026-11-24") {
  const start = Date.UTC(year, 0, 1), end = Date.UTC(year, 11, 31);
  const days = Array.from({ length: (end - start) / 86400000 + 1 }, (_, index) => ({
    date: new Date(start + index * 86400000).toISOString().slice(0, 10), learning_count: 0, interaction_count: 0, score: 0, level: 0,
  }));
  return { timezone: "America/Toronto", year, today, available_years: [2026, 2025, 2024],
    start_date: days[0].date, end_date: days.at(-1).date, days };
}

test("annual calendars cover Jan-Dec, leap years and 53 or54 complete week columns without inventing future activity", () => {
  const leap = activityCalendar(annual(2024));
  assert.equal(leap.days.length, 366);
  assert.equal(leap.days.find((day) => day.date === "2024-02-29").future, false);
  assert.equal(leap.months.length, 12);
  assert.equal(leap.columns, 53);
  const longYear = annual(2000, "2026-11-24");
  assert.equal(activityCalendar(longYear).columns, 54);
  const current = activityCalendar(annual());
  assert.equal(current.days.length, 365);
  assert.equal(current.days.find((day) => day.date === "2026-11-25").future, true);
  assert.equal(current.days.find((day) => day.date === "2026-11-24").future, false);
  const invalid = annual(); invalid.days.at(-1).interaction_count = 1;
  assert.throws(() => activityCalendar(invalid), /future/);
});

test("calendar uses 182 real local dates across DST and pads only partial weeks", () => {
  const data = fixture();
  data.days.at(-1).learning_count = 5;
  data.days.at(-1).interaction_count = 10;
  data.days.at(-1).score = 100;
  data.days.at(-1).level = 4;
  const view = activityCalendar(data);
  assert.equal(view.days.length, 182);
  assert.equal(view.days.find((day) => day.date === "2026-11-01").date, "2026-11-01");
  assert.equal(view.cells.length % 7, 0);
  assert.equal(view.cells.filter(Boolean).length, 182);
  assert.equal(view.columns, 27);
  assert.deepEqual(view.totals, { learning: 5, interaction: 10, active: 1 });
  assert.equal(view.days[0].date, data.start_date);
  assert.equal(view.days.at(-1).date, data.end_date);
});

test("malformed, duplicate, incomplete and impossible dates cannot become invented activity", () => {
  for (const change of [
    (d) => d.days.pop(), (d) => { d.days[1] = d.days[0]; },
    (d) => { d.days[0].date = "2026-02-30"; }, (d) => { d.end_date = "2026-11-25"; },
    (d) => { d.days[0].learning_count = -1; }, (d) => { d.days[0].level = 5; },
    (d) => { d.days[0].score = NaN; }, (d) => { d.timezone = "unknown/timezone"; },
  ]) {
    const data = fixture(); change(data);
    assert.throws(() => activityCalendar(data));
  }
});

class Element {
  constructor(document) {
    this.ownerDocument = document; this.children = []; this.dataset = {}; this.attributes = new Map(); this.events = new Map();
    this.style = { setProperty() {} }; this.classList = { toggle() {}, add() {} }; this.textContent = "";
  }
  append(...nodes) { for (const node of nodes) {
    if (node.fragment) this.append(...node.children);
    else { this.children.push(node); node.parentElement = this; }
  } }
  replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  addEventListener(type, handler) { this.events.set(type, handler); }
  matches(selector) {
    const attribute = selector.match(/^\[([\w-]+)="([^"]+)"\]$/);
    if (attribute && !attribute[1].startsWith("data-")) return this.attributes.get(attribute[1]) === attribute[2];
    const match = selector.match(/^\[data-([\w-]+)(?:="([^"]+)")?\]$/);
    const key = match?.[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return Boolean(match && this.dataset[key] !== undefined && (match[2] === undefined || this.dataset[key] === match[2]));
  }
  querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
  contains(node) { return Boolean(node && (node === this || this.children.some((child) => child.contains(node)))); }
  focus() { this.ownerDocument.activeElement = this; }
  fire(type, target = this, fields = {}) { this.events.get(type)?.({ target, preventDefault() {}, ...fields }); }
}
function dom() {
  const document = { activeElement: null, addEventListener() {}, createElement: () => new Element(document),
    createDocumentFragment: () => Object.assign(new Element(document), { fragment: true }) };
  globalThis.document = document;
  const root = new Element(document);
  for (const name of ["grid", "calendar", "range", "status", "detail", "months", "weekdays", "year", "legend"])
    root.append(Object.assign(new Element(document), { dataset: { [`activity${name[0].toUpperCase()}${name.slice(1)}`]: "" } }));
  root.append(Object.assign(new Element(document), { dataset: { activityAction: "retry" } }));
  const node = (name) => root.querySelector(`[data-activity-${name}]`);
  const yearButton = () => node("year").children[0];
  const yearList = () => node("year").children[1];
  return { root, node, document, yearButton, yearList };
}

test("real zero days, localized details, keyboard navigation and account clearing stay accessible", () => {
  const { root, node, document } = dom();
  let language = "en";
  const view = createActivityView(root, { getLanguage: () => language });
  view.loading();
  assert.equal(root.attributes.get("aria-busy"), "true");
  const data = fixture();
  view.render(data);
  const cells = node("grid").querySelectorAll("[data-activity-date]");
  assert.equal(cells.length, 182);
  assert.equal(cells.filter((cell) => cell.tabIndex === 0).length, 1);
  assert.equal(cells.at(-1).tabIndex, 0);
  assert.match(cells.at(-1).attributes.get("aria-label"), /Nov 24, 2026.*0 word\/phrase encounters.*0\/100/);
  assert.equal(node("status").textContent, "Only the available recent period is shown.");
  node("grid").fire("keydown", cells.at(-1), { key: "ArrowLeft" });
  assert.equal(document.activeElement.dataset.activityDate, "2026-11-17");
  assert.match(node("detail").textContent, /Nov 17, 2026/);
  language = "zh";
  view.render(data);
  assert.match(node("detail").textContent, /2026年11月17日/);
  assert.equal(document.activeElement.dataset.activityDate, "2026-11-17", "relabel preserves focused date");
  view.error(new Error("private provider detail"));
  assert.doesNotMatch(node("status").textContent, /private/);
  assert.equal(root.querySelector('[data-activity-action="retry"]').hidden, false);
  view.loading(false);
  assert.match(node("status").textContent, /无法读取/);
  view.clear();
  assert.equal(node("grid").children.length, 0);
  assert.equal(node("calendar").hidden, true);
  assert.equal(node("detail").title, node("detail").textContent);
});

test("annual view labels months/weekdays, disables future cells and selects years without losing navigation on errors", () => {
  const { root, node, document, yearButton, yearList } = dom();
  const years = [];
  const view = createActivityView(root, { onYearChange: (year) => years.push(year) });
  view.render(annual());
  assert.equal(node("months").children.length, 12);
  assert.equal(node("months").children[0].children[0].textContent, "Jan");
  assert.equal(node("months").children.at(-1).children[0].textContent, "Dec");
  assert.equal(node("weekdays").children.length, 7);
  assert.equal(node("weekdays").children[1].children[0].textContent, "Mon");
  assert.equal(yearButton().children[0].textContent, "2026");
  assert.equal(yearButton().disabled, false);
  assert.equal(node("range").hidden, true, "annual navigation does not waste a row on the old rolling range");
  const cells = node("grid").querySelectorAll("[data-activity-date]");
  const today = cells.find((cell) => cell.dataset.activityDate === "2026-11-24");
  const future = cells.find((cell) => cell.dataset.activityDate === "2026-11-25");
  assert.equal(future.disabled, true);
  assert.match(future.title, /Future date/);
  assert.equal(today.tabIndex, 0);
  today.focus();
  node("grid").fire("keydown", today, { key: "End" });
  assert.equal(document.activeElement, today, "End skips all future cells");
  yearList().children[2].fire("click");
  assert.deepEqual(years, [2024]);
  view.clear({ preserveYears: true, year: 2024 });
  view.error(new Error("unavailable"));
  assert.equal(node("grid").children.length, 0);
  assert.equal(yearList().children.length, 3);
  assert.equal(yearButton().disabled, false);
  view.clear();
  assert.equal(yearList().children.length, 0, "account clearing drops previous tenant year choices");
  assert.equal(yearButton().disabled, true);
});

test("a retained historical selection can still return to current year if its last record was deleted", () => {
  const { root, yearButton, yearList } = dom();
  const view = createActivityView(root);
  view.render({ ...annual(2024), available_years: [2026] });
  assert.equal(yearList().children.length, 2);
  assert.equal(yearButton().disabled, false);
});

test("a single available year opens a real menu, closes without reloading and clears safely", async () => {
  const { root, yearButton, yearList, document } = dom();
  const changes = [];
  const view = createActivityView(root, { onYearChange: (year) => changes.push(year) });
  assert.equal(yearButton().disabled, true);
  view.render({ ...annual(), available_years: [2026] });
  assert.equal(yearButton().disabled, false);
  yearButton().fire("click");
  assert.equal(yearButton().attributes.get("aria-expanded"), "true");
  assert.equal(yearList().hidden, false);
  assert.equal(yearList().children.length, 1);
  assert.equal(yearList().children[0].children[0].textContent, "2026");
  assert.equal(document.activeElement, yearList().children[0]);
  yearList().children[0].fire("click");
  await Promise.resolve();
  assert.equal(yearButton().attributes.get("aria-expanded"), "false");
  assert.deepEqual(changes, [], "choosing the current year does not fetch it again");
  yearButton().fire("keydown", yearButton(), { key: "ArrowDown" });
  assert.equal(yearButton().attributes.get("aria-expanded"), "true");
  view.loading();
  assert.equal(yearButton().disabled, true);
  assert.equal(yearButton().attributes.get("aria-expanded"), "false");
  view.loading(false);
  yearButton().fire("click");
  view.clear();
  assert.equal(yearButton().attributes.get("aria-expanded"), "false");
  assert.equal(yearList().children.length, 0);
});

test("both profile and settings use one bounded shell with an internal scrolling body", async () => {
  const css = await readFile(new URL("../web/style.css", import.meta.url), "utf8");
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.match(css, /dialog\.profile-dialog,\s*#settings-dialog\s*\{[^}]*width: min\(560px[^}]*height: min\(650px/s);
  assert.match(css, /\.dialog-body\s*\{[^}]*overflow-y: auto/s);
  for (const id of ["local-profile-dialog", "settings-dialog"])
    assert.match(html.match(new RegExp(`<dialog id="${id}"[\\s\\S]*?<\\/dialog>`))[0], /class="dialog-body"/);
  for (const language of ["en", "zh", "ja", "ko", "fr", "es"])
    assert.notEqual(activityText(language, "activityDayDetail", { date: "date", learning: 1, interactions: 2, score: 20 }), "activityDayDetail");
});
