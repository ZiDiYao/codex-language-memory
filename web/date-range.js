import { reveal, conceal } from "./motion.js";
import { calendarDate, calendarDays, localDate, selectDate } from "./export-model.js";

/** A compact two-click range calendar, with keyboard navigation and local dates. */
export class DateRange {
  constructor(host, {t, getLocale, onChange}) {
    Object.assign(this, {host, t, getLocale, onChange});
    this.from = this.through = "";
    this.month = localDate();
    this.endpoint = "start";
    this.expanded = false;
    host.innerHTML = `<button type="button" class="picker-trigger date-trigger" aria-expanded="false" aria-controls="export-calendar"></button>
      <div id="export-calendar" class="range-calendar" hidden>
        <div class="range-endpoints"><button type="button" data-endpoint="start"></button><span aria-hidden="true">→</span><button type="button" data-endpoint="end"></button></div>
        <div class="calendar-heading"><button type="button" class="calendar-prev">‹</button><strong aria-live="polite"></strong><button type="button" class="calendar-next">›</button></div>
        <div class="calendar-weekdays" aria-hidden="true"></div><div class="calendar-days" role="group"></div>
        <div class="calendar-footer"><span class="calendar-legend" hidden></span><button type="button" class="calendar-clear"></button></div>
      </div>`;
    this.trigger = host.querySelector(".date-trigger");
    this.panel = host.querySelector(".range-calendar");
    this.days = host.querySelector(".calendar-days");
    this.trigger.addEventListener("click", () => this.expanded ? this.close() : this.open());
    host.querySelectorAll("[data-endpoint]").forEach(button => button.addEventListener("click", () => {
      this.endpoint = button.dataset.endpoint;
      this.month = (this.endpoint === "start" ? this.from : this.through) || this.from || localDate();
      this.render();
    }));
    host.querySelector(".calendar-prev").addEventListener("click", () => this.changeMonth(-1));
    host.querySelector(".calendar-next").addEventListener("click", () => this.changeMonth(1));
    host.querySelector(".calendar-clear").addEventListener("click", () => {
      this.reset(); this.onChange();
    });
    host.addEventListener("keydown", event => {
      if (event.key === "Escape" && this.expanded) {
        event.preventDefault(); event.stopPropagation(); this.close(true);
      }
    });
    this.days.addEventListener("keydown", event => {
      const value = event.target.dataset.date;
      if (!value) return;
      const date = calendarDate(value);
      const steps = {ArrowLeft:-1, ArrowRight:1, ArrowUp:-7, ArrowDown:7};
      if (event.key in steps) date.setDate(date.getDate() + steps[event.key]);
      else if (event.key === "Home") date.setDate(date.getDate() - (date.getDay() + 6) % 7);
      else if (event.key === "End") date.setDate(date.getDate() + 6 - (date.getDay() + 6) % 7);
      else return;
      event.preventDefault(); this.month = localDate(date); this.render(localDate(date));
    });
    this.render();
  }

  dayLabel(value, options = {month:"short", day:"numeric", year:"numeric"}) {
    return new Intl.DateTimeFormat(this.getLocale(), options).format(calendarDate(value));
  }

  summary() {
    if (!this.from) return this.t("exportAllTime");
    return `${this.dayLabel(this.from)} – ${this.through ? this.dayLabel(this.through) : this.t("exportThrough")}`;
  }

  reset() {
    this.from = this.through = ""; this.endpoint = "start"; this.month = localDate(); this.render();
  }

  open() {
    this.expanded = true;
    this.month = this.from || localDate();
    this.endpoint = this.from && !this.through ? "end" : "start";
    this.trigger.setAttribute("aria-expanded", "true");
    this.render(); reveal(this.panel);
  }

  close(focus = false) {
    this.expanded = false;
    this.trigger.setAttribute("aria-expanded", "false");
    conceal(this.panel);
    if (focus) this.trigger.focus();
  }

  changeMonth(amount) {
    const date = calendarDate(this.month.slice(0, 7) + "-01");
    date.setMonth(date.getMonth() + amount);
    this.month = localDate(date); this.render();
  }

  render(focusDate) {
    this.trigger.textContent = this.summary();
    this.trigger.setAttribute("aria-label", `${this.t("exportRangeLabel")}: ${this.summary()}`);
    for (const [endpoint, key, value] of [["start", "exportFrom", this.from], ["end", "exportThrough", this.through]]) {
      const button = this.host.querySelector(`[data-endpoint="${endpoint}"]`);
      button.textContent = `${this.t(key)}${value ? ` · ${this.dayLabel(value, {month:"short",day:"numeric"})}` : ""}`;
      button.setAttribute("aria-pressed", String(this.endpoint === endpoint));
    }
    this.host.querySelector(".calendar-heading strong").textContent = this.dayLabel(this.month, {month:"long",year:"numeric"});
    this.host.querySelector(".calendar-prev").setAttribute("aria-label", this.t("exportPreviousMonth"));
    this.host.querySelector(".calendar-next").setAttribute("aria-label", this.t("exportNextMonth"));
    this.host.querySelector(".calendar-clear").textContent = this.t("exportAllTime");
    this.days.setAttribute("aria-label", this.t(this.endpoint === "start" ? "exportFrom" : "exportThrough"));
    const weekdays = this.host.querySelector(".calendar-weekdays");
    weekdays.replaceChildren(...calendarDays("2026-06-01").slice(0, 7).map(value => {
      const span = document.createElement("span");
      span.textContent = this.dayLabel(value, {weekday:"narrow"}); return span;
    }));
    const focus = focusDate || this.through || this.from || localDate();
    const values = calendarDays(this.month);
    const tabStop = values.includes(focus) ? focus : this.month.slice(0, 7) + "-01";
    this.days.replaceChildren(...values.map(value => {
      const button = document.createElement("button");
      button.type = "button"; button.dataset.date = value;
      button.textContent = String(calendarDate(value).getDate());
      button.tabIndex = value === tabStop ? 0 : -1;
      button.setAttribute("aria-label", this.dayLabel(value, {dateStyle:"full"}));
      button.setAttribute("aria-pressed", String(value === this.from || value === this.through));
      if (value === localDate()) button.setAttribute("aria-current", "date");
      button.classList.toggle("outside-month", value.slice(0,7) !== this.month.slice(0,7));
      button.classList.toggle("in-range", Boolean(this.from && this.through && value > this.from && value < this.through));
      button.classList.toggle("last-export-day", value === this.marker);
      if (value === this.marker) button.title = this.t("exportLastThrough", {day:this.dayLabel(value)});
      button.addEventListener("click", () => {
        Object.assign(this, selectDate(this.from, value, this.endpoint));
        this.endpoint = this.through ? "start" : "end";
        this.month = value; this.render(value); this.onChange();
      });
      return button;
    }));
    const legend = this.host.querySelector(".calendar-legend");
    legend.hidden = !this.marker;
    legend.textContent = this.t("exportLastMarker");
    if (focusDate) this.days.querySelector(`[data-date="${focusDate}"]`)?.focus();
  }
}
