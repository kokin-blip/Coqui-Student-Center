/** Resolve a wall-clock time in the student's saved timezone, including DST folds. */
export function completionInstants(date: string, time: string, timezone: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return [];
  const wanted = `${date}T${time}`;
  const utc = Date.parse(`${wanted}:00Z`);
  if (!Number.isFinite(utc)) return [];
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const stamp = (ms: number) => { const p = format.formatToParts(ms); const v = (key: string) => p.find(x => x.type === key)?.value; return `${v("year")}-${v("month")}-${v("day")}T${v("hour")}:${v("minute")}`; };
  // Sample the offsets either side of transitions; verify each candidate by round trip.
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) { const ms = utc + hours * 3600000; offsets.add(Date.parse(`${stamp(ms)}:00Z`) - ms); }
  return [...offsets].map(offset => utc - offset).filter(ms => stamp(ms) === wanted).sort((a,b) => a-b).map(ms => new Date(ms).toISOString());
}
export function timezoneLabel(timezone: string, instant = new Date()): string {
  const name = new Intl.DateTimeFormat(undefined, { timeZone: timezone, timeZoneName: "long" }).formatToParts(instant).find(p => p.type === "timeZoneName")?.value;
  return `${name} (${timezone.replaceAll("_", " ")})`;
}
