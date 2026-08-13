export const READER_TIME_ZONE = "America/New_York";

export function calendarDateInTimeZone(
  instant: Date,
  timeZone: string,
): string {
  if (!Number.isFinite(instant.getTime())) {
    throw new RangeError("Invalid calendar-date instant.");
  }

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(instant)
      .flatMap(({ type, value }) =>
        type === "literal" ? [] : [[type, value]],
      ),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function readerCalendarDate(instant: Date): string {
  return calendarDateInTimeZone(instant, READER_TIME_ZONE);
}
