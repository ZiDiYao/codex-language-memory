/** Inclusive local calendar dates become an exclusive UTC end boundary. */
export function localDate(date = new Date()) {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function calendarDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(12, 0, 0, 0);
  return date;
}

export function calendarDays(month) {
  const first = calendarDate(month.slice(0, 7) + "-01");
  first.setDate(first.getDate() - (first.getDay() + 6) % 7);
  return Array.from({length: 42}, (_, offset) => {
    const date = new Date(first);
    date.setDate(first.getDate() + offset);
    return localDate(date);
  });
}

export function selectDate(from, date, endpoint) {
  if (endpoint === "start" || !from) return {from: date, through: ""};
  return date < from ? {from: date, through: from} : {from, through: date};
}

export function exportRange(period, from = "", through = "", now = new Date()) {
  if (period === "all") return {};
  function date(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("exportDateInvalid");
    const [year, month, day] = value.split("-").map(Number);
    const result = new Date(0);
    result.setFullYear(year, month - 1, day);
    result.setHours(0, 0, 0, 0);
    if (result.getFullYear() !== year || result.getMonth() !== month - 1 || result.getDate() !== day)
      throw new Error("exportDateInvalid");
    return result;
  }
  let start, end;
  if (period === "custom") {
    if (!from && !through) throw new Error("exportDateInvalid");
    if (from) start = date(from);
    if (through) { end = date(through); end.setDate(end.getDate() + 1); }
  } else {
    if (!["7", "30", "90"].includes(period)) throw new Error("exportDateInvalid");
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - Number(period) + 1);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  }
  if (start && end && start >= end) throw new Error("exportDateInvalid");
  return { ...(start && { start_at: start.toISOString() }), ...(end && { end_at: end.toISOString() }) };
}
