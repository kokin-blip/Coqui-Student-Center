import type { AcademicTermRecord, AvailabilityInput, CommitmentRecord, PlanningPreferenceRecord, RhythmRuleRecord, SemesterScenarioSection, TaskRecord } from "../../native";

type Meeting = Pick<SemesterScenarioSection, "weekdays" | "startsAtLocal" | "endsAtLocal" | "modality" | "courseId"> & { location?: string; rotationIntervalWeeks?: number; rotationOffsetWeeks?: number };
type Window = { start: number; end: number };
export type ScheduleDayAnalysis = {
  weekday: number;
  classMinutes: number;
  commuteMinutes: number;
  classConflictMinutes: number;
  rhythmConflictMinutes: number;
  sleepConflictMinutes: number;
  commuteConflictMinutes: number;
  missingMealWindows: number;
  studyMinutes: number | null;
};
export type ScheduleAnalysis = {
  days: ScheduleDayAnalysis[];
  weeklyStudyMinutes: number | null;
  weeklyKnownEffortMinutes: number;
  overloadMinutes: number | null;
  preferredSleepMinutes: number | null;
  missingInputs: string[];
  warnings: string[];
};

const clock = (value: string) => { const [hour, minute] = value.split(":").map(Number); return hour * 60 + minute; };
const overlap = (a: Window, b: Window) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const clipped = (value: Window): Window => ({ start: Math.max(0, value.start), end: Math.min(1440, value.end) });
function coveredMinutes(windows: Window[]): number {
  const sorted = windows.map(clipped).filter((window) => window.end > window.start).sort((a, b) => a.start - b.start);
  let total = 0; let end = 0;
  for (const window of sorted) { total += Math.max(0, window.end - Math.max(window.start, end)); end = Math.max(end, window.end); }
  return total;
}
const blockedMinutes = (window: Window, blocks: Window[]) => coveredMinutes(blocks.map((block) => ({ start: Math.max(window.start, block.start), end: Math.min(window.end, block.end) })));
const dateMs = 86_400_000;
function localStamp(iso: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { day: `${value("year")}-${String(value("month")).padStart(2, "0")}-${String(value("day")).padStart(2, "0")}`, minute: value("hour") * 60 + value("minute") };
}
function datedWindows(commitments: CommitmentRecord[], dayKey: string, timezone: string): Window[] {
  return commitments.filter((item) => item.kind !== "class").flatMap((item) => {
    const start = localStamp(item.startsAt, timezone); const end = localStamp(item.endsAt, timezone);
    if (dayKey < start.day || dayKey > end.day) return [];
    const window = { start: start.day === dayKey ? start.minute : 0, end: end.day === dayKey ? end.minute : 1440 };
    return [window, ...(start.day === dayKey && item.travelBeforeMinutes > 0 ? [{ start: window.start - item.travelBeforeMinutes, end: window.start }] : []), ...(end.day === dayKey && item.travelAfterMinutes > 0 ? [{ start: window.end, end: window.end + item.travelAfterMinutes }] : [])];
  });
}

export function analyzeSemesterSchedule(
  meetings: Meeting[], rhythmRules: RhythmRuleRecord[], availability: AvailabilityInput[],
  term: Pick<AcademicTermRecord, "startsOn" | "endsOn">, preferences: PlanningPreferenceRecord | null,
  tasks: Pick<TaskRecord, "courseId" | "completed" | "dueAt" | "minutes">[],
  commitments: CommitmentRecord[] = [], timezone = "UTC",
): ScheduleAnalysis {
  const start = Date.parse(`${term.startsOn}T00:00:00Z`);
  const end = Date.parse(`${term.endsOn}T00:00:00Z`);
  const weeks = Math.max(1, Math.ceil((end - start + dateMs) / (7 * dateMs)));
  const totals = Array.from({ length: 7 }, (_, weekday) => ({ weekday, classMinutes: 0, commuteMinutes: 0, classConflictMinutes: 0, rhythmConflictMinutes: 0, sleepConflictMinutes: 0, commuteConflictMinutes: 0, missingMealWindows: 0, studyMinutes: availability.length ? 0 : null as number | null, occurrences: 0 }));
  let uncertainBetweenClassTravel = false;
  const sleepStart = preferences ? clock(preferences.sleepStart) : null;
  const sleepEnd = preferences ? clock(preferences.sleepEnd) : null;
  const preferredSleepMinutes = sleepStart === null || sleepEnd === null ? null : (sleepEnd - sleepStart + 1440) % 1440;
  const sleepWindows: Window[] = sleepStart === null || sleepEnd === null ? [] : sleepStart > sleepEnd ? [{ start: 0, end: sleepEnd }, { start: sleepStart, end: 1440 }] : [{ start: sleepStart, end: sleepEnd }];
  for (let date = start; date <= end; date += dateMs) {
    const weekday = new Date(date).getUTCDay();
    const week = Math.floor((date - start) / (7 * dateMs));
    const day = totals[weekday]; day.occurrences++;
    const classes = meetings.filter((meeting) => meeting.weekdays.includes(weekday) && week % (meeting.rotationIntervalWeeks ?? 1) === (meeting.rotationOffsetWeeks ?? 0))
      .map((meeting) => ({ start: clock(meeting.startsAtLocal), end: clock(meeting.endsAtLocal), modality: meeting.modality, location: meeting.location?.trim().toLowerCase() ?? "" }))
      .filter((window) => Number.isFinite(window.start) && Number.isFinite(window.end) && window.end > window.start).sort((a, b) => a.start - b.start);
    const dayKey = new Date(date).toISOString().slice(0, 10);
    const rules = [...rhythmRules.filter((rule) => rule.weekday === weekday).map((rule) => ({ start: clock(rule.startsAtLocal), end: clock(rule.endsAtLocal) })), ...datedWindows(commitments, dayKey, timezone)].filter((window) => window.end > window.start);
    const inPerson = classes.filter((window) => window.modality === "in_person");
    if (inPerson.some((item, index) => index > 0 && (item.location !== inPerson[index - 1].location || !item.location))) uncertainBetweenClassTravel = true;
    const commute = inPerson.length && preferences?.defaultCommuteMinutes ? [
      clipped({ start: inPerson[0].start - preferences.defaultCommuteMinutes, end: inPerson[0].start }),
      clipped({ start: inPerson[inPerson.length - 1].end, end: inPerson[inPerson.length - 1].end + preferences.defaultCommuteMinutes }),
    ] : [];
    day.classMinutes += classes.reduce((sum, window) => sum + window.end - window.start, 0);
    day.commuteMinutes += coveredMinutes(commute);
    day.classConflictMinutes += classes.reduce((sum, window, index) => sum + blockedMinutes(window, classes.slice(0, index)), 0);
    day.rhythmConflictMinutes += coveredMinutes(classes.flatMap((window) => rules.map((rule) => ({ start: Math.max(window.start, rule.start), end: Math.min(window.end, rule.end) }))));
    day.sleepConflictMinutes += coveredMinutes(classes.flatMap((window) => sleepWindows.map((sleep) => ({ start: Math.max(window.start, sleep.start), end: Math.min(window.end, sleep.end) }))));
    day.commuteConflictMinutes += commute.reduce((sum, window) => sum + blockedMinutes(window, [...classes, ...rules, ...sleepWindows]), 0);
    const blocked = [...classes, ...commute, ...rules, ...sleepWindows];
    for (const mealWindow of [{ start: 11 * 60, end: 14 * 60 }, { start: 17 * 60, end: 20 * 60 }]) {
      if (mealWindow.end - mealWindow.start - blockedMinutes(mealWindow, blocked) < 30) day.missingMealWindows++;
    }
    if (day.studyMinutes !== null) {
      const study = availability.filter((window) => window.weekday === weekday).map((window) => ({ start: clock(window.startsAtLocal), end: clock(window.endsAtLocal) }));
      day.studyMinutes += study.reduce((sum, window) => sum + Math.max(0, window.end - window.start - blockedMinutes(window, blocked)), 0);
    }
  }
  const days = totals.map(({ occurrences, ...day }) => ({ ...day, classMinutes: day.classMinutes / weeks, commuteMinutes: day.commuteMinutes / weeks, classConflictMinutes: day.classConflictMinutes / weeks, rhythmConflictMinutes: day.rhythmConflictMinutes / weeks, sleepConflictMinutes: day.sleepConflictMinutes / weeks, commuteConflictMinutes: day.commuteConflictMinutes / weeks, missingMealWindows: day.missingMealWindows / Math.max(1, occurrences), studyMinutes: day.studyMinutes === null ? null : day.studyMinutes / weeks }));
  const weeklyStudyMinutes = days.every((day) => day.studyMinutes !== null) ? days.reduce((total, day) => total + (day.studyMinutes ?? 0), 0) : null;
  const courseIds = new Set(meetings.map((meeting) => meeting.courseId));
  const weeklyKnownEffortMinutes = tasks.filter((task) => !task.completed && task.courseId && courseIds.has(task.courseId) && task.dueAt && task.dueAt.slice(0, 10) >= term.startsOn && task.dueAt.slice(0, 10) <= term.endsOn).reduce((sum, task) => sum + task.minutes, 0) / weeks;
  const missingInputs = [!preferences && "Sleep and commute preferences", !availability.length && "Preferred study windows", preferences?.defaultCommuteMinutes === 0 && meetings.some((meeting) => meeting.modality === "in_person") && "Commute estimate", uncertainBetweenClassTravel && "Travel time between in-person class locations", !tasks.some((task) => task.courseId && courseIds.has(task.courseId)) && "Assignment effort"].filter((value): value is string => typeof value === "string");
  const warnings = [days.some((day) => day.classConflictMinutes > 0) && "Classes overlap", days.some((day) => day.rhythmConflictMinutes > 0) && "Classes overlap your weekly rhythm", days.some((day) => day.sleepConflictMinutes > 0) && "Classes overlap your preferred sleep hours", days.some((day) => day.commuteConflictMinutes > 0) && "Commute overlaps another commitment or class", days.some((day) => day.missingMealWindows > 0) && "Some days leave less than 30 minutes for lunch or dinner", preferredSleepMinutes !== null && preferredSleepMinutes < 8 * 60 && "Your preferred sleep window is shorter than eight hours", weeklyStudyMinutes !== null && weeklyKnownEffortMinutes > weeklyStudyMinutes && "Known assignment effort exceeds preferred study capacity"].filter((value): value is string => typeof value === "string");
  return { days, weeklyStudyMinutes, weeklyKnownEffortMinutes, overloadMinutes: weeklyStudyMinutes === null ? null : Math.max(0, weeklyKnownEffortMinutes - weeklyStudyMinutes), preferredSleepMinutes, missingInputs, warnings };
}
