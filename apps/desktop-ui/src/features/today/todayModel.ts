import type { PlanBlock, TaskRecord, WorkspaceSnapshot } from "../../native";

export function dayKey(value: string | Date, timezone: string): string {
  // A date-only deadline is a calendar date, not a UTC-midnight instant.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
    return value;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export const shiftDay = (day: string, amount: number) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + amount * 86400000)
    .toISOString()
    .slice(0, 10);
export const mondayOf = (day: string) =>
  shiftDay(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
export const dateLabel = (day: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat([], { ...options, timeZone: "UTC" }).format(
    new Date(`${day}T12:00:00Z`),
  );
export function minuteOfDay(value: string | Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  return (
    Number(parts.find((p) => p.type === "hour")?.value) * 60 +
    Number(parts.find((p) => p.type === "minute")?.value)
  );
}
export const clockLabel = (minutes: number) =>
  new Intl.DateTimeFormat([], {
    hour: "numeric",
    ...(minutes % 60 ? { minute: "2-digit" as const } : {}),
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2026, 0, 1, 0, minutes)));
export function dueLabel(task: TaskRecord, today: string, timezone: string) {
  if (!task.dueAt) return "No deadline";
  const due = dayKey(task.dueAt, timezone);
  if (due < today) return "Overdue";
  if (due === today) return "Today";
  if (due === shiftDay(today, 1)) return "Tomorrow";
  return dateLabel(due, { month: "short", day: "numeric" });
}
export const priorityLabel = (priority: number) =>
  priority >= 4 ? "High" : priority >= 2 ? "Medium" : "Low";
export const riskLabel = (risk: number) =>
  risk >= 4 ? "High" : risk >= 2 ? "Medium" : "Low";

export function blocksForDay(
  blocks: PlanBlock[],
  day: string,
  timezone: string,
) {
  return blocks.filter(
    (b) =>
      dayKey(b.startsAt, timezone) <= day &&
      dayKey(new Date(Date.parse(b.endsAt) - 1), timezone) >= day,
  );
}

export function positionBlocks(
  blocks: PlanBlock[],
  day: string,
  timezone: string,
) {
  const placed = blocksForDay(blocks, day, timezone)
    .map((block) => ({
      block,
      start:
        dayKey(block.startsAt, timezone) < day
          ? 0
          : minuteOfDay(block.startsAt, timezone),
      end:
        dayKey(block.endsAt, timezone) > day
          ? 1440
          : minuteOfDay(block.endsAt, timezone),
      lane: 0,
      lanes: 1,
    }))
    .sort(
      (a, b) =>
        a.start - b.start ||
        b.end - a.end ||
        a.block.id.localeCompare(b.block.id),
    );
  let group: typeof placed = [];
  let groupEnd = -1;
  const finish = () => {
    const lanes = Math.max(1, ...group.map((p) => p.lane + 1));
    group.forEach((p) => {
      p.lanes = lanes;
    });
    group = [];
  };
  for (const item of placed) {
    if (item.start >= groupEnd) finish();
    const taken = new Set(
      group.filter((p) => p.end > item.start).map((p) => p.lane),
    );
    while (taken.has(item.lane)) item.lane++;
    group.push(item);
    groupEnd = Math.max(item.end, ...group.map((p) => p.end));
  }
  finish();
  return placed;
}

/** Wall-clock availability, explicitly labeled as a planning estimate. Fixed and
 * scheduled intervals are unioned, so overlaps never subtract the same minute twice. */
export function capacityForDay(
  workspace: WorkspaceSnapshot | null,
  blocks: PlanBlock[],
  day: string,
  timezone: string,
  now: Date,
) {
  if (!workspace?.availability.length) return null;
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const minutes = (s: string) =>
    Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const windows = workspace.availability
    .filter((w) => w.weekday === weekday)
    .map((w) => [minutes(w.startsAtLocal), minutes(w.endsAtLocal)]);
  const today = dayKey(now, timezone);
  const after =
    day === today ? minuteOfDay(now, timezone) : day < today ? 1440 : 0;
  const occupied = positionBlocks(
    blocks.filter((b) => !b.completed),
    day,
    timezone,
  ).map((p) => [p.start, p.end]);
  for (const c of workspace.commitments) {
    if (
      dayKey(c.startsAt, timezone) <= day &&
      dayKey(c.endsAt, timezone) >= day
    ) {
      occupied.push([
        dayKey(c.startsAt, timezone) < day
          ? 0
          : minuteOfDay(c.startsAt, timezone) - c.travelBeforeMinutes,
        dayKey(c.endsAt, timezone) > day
          ? 1440
          : minuteOfDay(c.endsAt, timezone) + c.travelAfterMinutes,
      ]);
    }
  }
  const sleep = workspace.preferences;
  let available = 0,
    free = 0;
  for (let minute = after; minute < 1440; minute++) {
    if (!windows.some(([start, end]) => minute >= start && minute < end))
      continue;
    if (sleep) {
      const start = minutes(sleep.sleepStart),
        end = minutes(sleep.sleepEnd);
      if (
        start > end
          ? minute >= start || minute < end
          : minute >= start && minute < end
      )
        continue;
    }
    available++;
    if (!occupied.some(([start, end]) => minute >= start && minute < end))
      free++;
  }
  return {
    available,
    free,
    label:
      available === 0
        ? "No availability"
        : free >= 120
          ? "High"
          : free >= 60
            ? "Moderate"
            : "Low",
  };
}
