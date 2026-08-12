const MONTH_INDEX = new Map<string, number>([
  ["january", 1],
  ["jan", 1],
  ["february", 2],
  ["feb", 2],
  ["march", 3],
  ["mar", 3],
  ["april", 4],
  ["apr", 4],
  ["may", 5],
  ["june", 6],
  ["jun", 6],
  ["july", 7],
  ["jul", 7],
  ["august", 8],
  ["aug", 8],
  ["september", 9],
  ["sep", 9],
  ["sept", 9],
  ["october", 10],
  ["oct", 10],
  ["november", 11],
  ["nov", 11],
  ["december", 12],
  ["dec", 12],
]);

type CalendarParts = {
  year: number;
  month: number;
  day: number;
};

function calendarParts(value: string): CalendarParts | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso !== null) {
    return {
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
    };
  }
  const monthFirst = /^([A-Za-z]+)\s+(\d{1,2})(?:,\s*|\s+)(\d{4})$/
    .exec(value);
  if (monthFirst !== null) {
    const month = MONTH_INDEX.get(monthFirst[1]!.toLowerCase());
    if (month === undefined) return null;
    return {
      year: Number(monthFirst[3]),
      month,
      day: Number(monthFirst[2]),
    };
  }
  const dayFirst = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(value);
  if (dayFirst === null) return null;
  const month = MONTH_INDEX.get(dayFirst[2]!.toLowerCase());
  if (month === undefined) return null;
  return {
    year: Number(dayFirst[3]),
    month,
    day: Number(dayFirst[1]),
  };
}

function calendarDate(parts: CalendarParts): Date | null {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  return date.getUTCFullYear() === parts.year &&
      date.getUTCMonth() === parts.month - 1 &&
      date.getUTCDate() === parts.day
    ? date
    : null;
}

export function exactCalendarTimestamp(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw.length === 0) return null;
  const parts = calendarParts(raw);
  if (parts !== null) return calendarDate(parts)?.toISOString() ?? null;

  const timestamp = /^(\d{4}-\d{2}-\d{2})T.+(?:Z|[+-]\d{2}:\d{2})$/i
    .exec(raw);
  if (timestamp === null) return null;
  const timestampDate = calendarParts(timestamp[1]!);
  if (timestampDate === null || calendarDate(timestampDate) === null) {
    return null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
