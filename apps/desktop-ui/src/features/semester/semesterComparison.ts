import type { AcademicTermRecord, RhythmRuleRecord, SemesterScenarioSection, TaskRecord } from "../../native";

type Meeting = Pick<SemesterScenarioSection, "weekdays" | "startsAtLocal" | "endsAtLocal" | "modality" | "courseId"> & { rotationIntervalWeeks?: number; rotationOffsetWeeks?: number };
const minutes = (clock: string) => { const [hour, minute] = clock.split(":").map(Number); return hour * 60 + minute; };
const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

export function compareSemester(meetings: Meeting[], rhythmRules: RhythmRuleRecord[], term: Pick<AcademicTermRecord, "startsOn" | "endsOn">, commuteMinutes: number, tasks: Pick<TaskRecord, "courseId" | "completed" | "dueAt" | "minutes">[]) {
  let classMinutes = 0;
  let gapMinutes = 0;
  let classConflictMinutes = 0;
  let rhythmConflictMinutes = 0;
  let campusDays = 0;
  const start = Date.parse(`${term.startsOn}T00:00:00Z`);
  const end = Date.parse(`${term.endsOn}T00:00:00Z`);
  const dayMs = 24 * 60 * 60 * 1000;
  const weeks = Math.max(1, Math.ceil((end - start + dayMs) / (7 * dayMs)));
  const rulesByDay = Array.from({ length: 7 }, (_, day) => rhythmRules.filter((rule) => rule.weekday === day).map((rule) => ({ start: minutes(rule.startsAtLocal), end: minutes(rule.endsAtLocal) })));
  for (let date = start; date <= end; date += dayMs) {
    const day = new Date(date).getUTCDay();
    const week = Math.floor((date - start) / (7 * dayMs));
    const windows = meetings.filter((meeting) => meeting.weekdays.includes(day) && week % (meeting.rotationIntervalWeeks ?? 1) === (meeting.rotationOffsetWeeks ?? 0)).map((meeting) => ({ start: minutes(meeting.startsAtLocal), end: minutes(meeting.endsAtLocal), modality: meeting.modality })).sort((a, b) => a.start - b.start);
    if (windows.some((window) => window.modality === "in_person")) campusDays++;
    let latestEnd = 0;
    for (const [index, window] of windows.entries()) {
      classMinutes += window.end - window.start;
      if (index > 0) {
        gapMinutes += Math.max(0, window.start - latestEnd);
        classConflictMinutes += Math.max(0, Math.min(window.end, latestEnd) - window.start);
      }
      latestEnd = Math.max(latestEnd, window.end);
      for (const rule of rulesByDay[day]) rhythmConflictMinutes += overlap(window, rule);
    }
  }
  const courseIds = new Set(meetings.map((meeting) => meeting.courseId));
  const knownWorkMinutes = tasks.filter((task) => !task.completed && task.courseId && courseIds.has(task.courseId) && task.dueAt && task.dueAt.slice(0, 10) >= term.startsOn && task.dueAt.slice(0, 10) <= term.endsOn).reduce((total, task) => total + task.minutes, 0);
  return { classMinutes: classMinutes / weeks, gapMinutes: gapMinutes / weeks, classConflictMinutes: classConflictMinutes / weeks, rhythmConflictMinutes: rhythmConflictMinutes / weeks, campusDays: campusDays / weeks, commuteMinutes: campusDays * 2 * commuteMinutes / weeks, knownWorkMinutes };
}
