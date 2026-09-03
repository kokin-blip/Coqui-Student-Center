import { dayKey, minuteOfDay, shiftDay } from "../today/todayModel";
export const localToIso = (
  day: string,
  minutes: number,
  timezone: string,
): string => {
  if (minutes === 1440) return localToIso(shiftDay(day, 1), 0, timezone);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isInteger(minutes) ||
    minutes < 0 ||
    minutes > 1440
  )
    throw new Error("Choose a valid calendar date and time.");
  const desired = Date.parse(
    `${day}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00Z`,
  );
  let guess = desired;
  for (let index = 0; index < 3; index += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const part = (type: string) =>
      Number(parts.find((item) => item.type === type)?.value ?? 0);
    guess +=
      desired -
      Date.UTC(
        part("year"),
        part("month") - 1,
        part("day"),
        part("hour"),
        part("minute"),
      );
  }
  const result = new Date(guess).toISOString();
  if (
    dayKey(result, timezone) !== day ||
    minuteOfDay(result, timezone) !== minutes
  )
    throw new Error(
      "That time does not exist because the clocks change. Choose another time.",
    );
  return result;
};
