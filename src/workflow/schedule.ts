export type ScheduleRunState = {
  status: "missing" | "pending" | "running" | "retryable" | "published" | "partial" | "failed";
};

export type ScheduleDecision = {
  run: boolean;
  editionDate: string;
  reason: "scheduled" | "outside_window" | "published";
};

function localParts(instant: Date, timeZone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant).flatMap(({ type, value }) =>
    type === "literal" ? [] : [[type, value]],
  ));
}

export function shouldRunAt(
  instant: Date,
  timeZone: string,
  runState: ScheduleRunState,
): ScheduleDecision {
  if (!Number.isFinite(instant.getTime())) throw new RangeError("Invalid schedule instant.");
  const parts = localParts(instant, timeZone);
  const editionDate = `${parts.year}-${parts.month}-${parts.day}`;
  if (runState.status === "published") {
    return { run: false, editionDate, reason: "published" };
  }
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  if (minute < 4 * 60 || minute > 5 * 60 + 50) {
    return { run: false, editionDate, reason: "outside_window" };
  }
  return { run: true, editionDate, reason: "scheduled" };
}
