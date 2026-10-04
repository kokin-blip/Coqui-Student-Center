import type { PlanBlock, TaskRecord, WorkspaceSnapshot } from "../../native";
import { localToIso } from "../calendar/calendarDate";
import { dayKey, shiftDay } from "../today/todayModel";

export type SchedulingConflict = { taskId: string; title: string; unscheduledMinutes: number; reasonCodes: string[] };
const minute = 60_000;
const clock = (value: string) => { const [h, m] = value.split(":").map(Number); return h * 60 + m; };
const duration = (block: PlanBlock) => (Date.parse(block.endsAt) - Date.parse(block.startsAt)) / minute;
type Window = { start: number; end: number };

/** Offline preview equivalent of the native deterministic planner. */
export function generateLocalSchedule(workspace: WorkspaceSnapshot, previous: PlanBlock[], now: Date, resetStyle = false) {
  const timezone = workspace.profile?.timezone ?? "UTC";
  const preferences = workspace.preferences;
  if (!preferences) return { blocks: previous, conflicts: [] as SchedulingConflict[] };
  const style = preferences.schedulingStyle ?? "mixed";
  const floor = Math.ceil(now.getTime() / (5 * minute)) * 5 * minute;
  const horizon = floor + 14 * 24 * 60 * minute;
  const gap = Math.max(preferences.breakMinutes, preferences.transitionMinutes) * minute;
  const fixed: PlanBlock[] = workspace.commitments.map(item => ({ ...item, taskId: undefined, completed: false, locked: true, sessionIndex: 0, reasonCodes: ["fixed_commitment"] }));
  // Keep fixture-only commitments in the preview until they have editable records.
  fixed.push(...previous.filter(block => !block.taskId && !workspace.commitments.some(item => item.id === block.id) && !block.id.startsWith("class:") && !block.id.startsWith("rhythm:")));
  const occupied: Window[] = workspace.commitments.map(item => ({ start: Date.parse(item.startsAt) - item.travelBeforeMinutes * minute, end: Date.parse(item.endsAt) + (item.travelAfterMinutes + preferences.transitionMinutes) * minute }));
  occupied.push(...fixed.filter(block => !workspace.commitments.some(item => item.id === block.id)).map(block => ({ start: Date.parse(block.startsAt), end: Date.parse(block.endsAt) + preferences.transitionMinutes * minute })));
  const windows: Window[] = [];
  const first = dayKey(now, timezone);
  for (let index = 0; index <= 14; index++) {
    const day = shiftDay(first, index);
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    const local = (minutes: number, zone = timezone) => Date.parse(localToIso(day, minutes, zone));
    for (const rule of workspace.availability.filter(rule => rule.weekday === weekday)) {
      windows.push({ start: Math.max(floor, local(clock(rule.startsAtLocal))), end: Math.min(horizon, local(clock(rule.endsAtLocal))) });
    }
    const sleepStart = clock(preferences.sleepStart), sleepEnd = clock(preferences.sleepEnd);
    if (sleepStart > sleepEnd) {
      occupied.push({ start: local(0), end: local(sleepEnd) }, { start: local(sleepStart), end: Date.parse(localToIso(shiftDay(day, 1), 0, timezone)) });
    } else if (sleepStart < sleepEnd) occupied.push({ start: local(sleepStart), end: local(sleepEnd) });
    for (const event of workspace.academicEvents.filter(event => event.noClass && event.startsOn <= day && event.endsOn >= day)) {
      occupied.push({ start: local(0), end: Date.parse(localToIso(shiftDay(day, 1), 0, timezone)) });
    }
    for (const rule of workspace.rhythmRules.filter(rule => rule.weekday === weekday)) {
      const start = local(clock(rule.startsAtLocal)), end = local(clock(rule.endsAtLocal));
      fixed.push({ id: `rhythm:${rule.id}:${day}`, title: rule.label || rule.kind, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), kind: "protected", completed: false, locked: true, sessionIndex: 0, location: "", reasonCodes: ["fixed_commitment"] });
      occupied.push({ start, end: end + preferences.transitionMinutes * minute });
    }
  }
  // Expand meetings in their own timezone and honor term dates and rotations.
  for (const meeting of workspace.classMeetings) {
    const term = workspace.terms.find(term => term.id === meeting.termId);
    const meetingFirst = dayKey(now, meeting.timezone);
    for (let index = 0; index <= 14; index++) {
      const day = shiftDay(meetingFirst, index);
      if (!meeting.weekdays.includes(new Date(`${day}T12:00:00Z`).getUTCDay()) || (term && (day < term.startsOn || day > term.endsOn))) continue;
      if (workspace.academicEvents.some(event => event.noClass && (!event.termId || event.termId === meeting.termId) && event.startsOn <= day && event.endsOn >= day)) continue;
      const week = term ? Math.floor((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${term.startsOn}T00:00:00Z`)) / (7 * 24 * 60 * minute)) : 0;
      if (meeting.rotationIntervalWeeks > 1 && week % meeting.rotationIntervalWeeks !== meeting.rotationOffsetWeeks) continue;
      const start = Date.parse(localToIso(day, clock(meeting.startsAtLocal), meeting.timezone)), end = Date.parse(localToIso(day, clock(meeting.endsAtLocal), meeting.timezone));
      const course = workspace.courses.find(course => course.id === meeting.courseId);
      fixed.push({ id: `class:${meeting.id}:${day}`, title: course?.code || course?.title || "Class", startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), kind: "class", completed: false, locked: true, sessionIndex: 0, location: meeting.location, reasonCodes: ["fixed_commitment"] });
      occupied.push({ start: start - preferences.defaultCommuteMinutes * minute, end: end + (preferences.defaultCommuteMinutes + preferences.transitionMinutes) * minute });
    }
  }
  const preserved = previous.filter(block => block.taskId && workspace.tasks.some(task => task.id === block.taskId) && (block.completed || block.locked || block.startedAt));
  occupied.push(...preserved.map(block => ({ start: Date.parse(block.startsAt) - gap, end: Date.parse(block.endsAt) + gap })));
  const blocks: PlanBlock[] = [...fixed, ...preserved];
  const conflicts: SchedulingConflict[] = [];
  const completion = new Map(workspace.tasks.filter(task => task.completed).map(task => [task.id, floor]));
  const pending = workspace.tasks.filter(task => !task.completed).sort((a, b) => b.priority - a.priority || b.academicRisk - a.academicRisk || (Date.parse(a.dueAt ?? "") || Infinity) - (Date.parse(b.dueAt ?? "") || Infinity) || a.id.localeCompare(b.id));
  const fail = (task: TaskRecord, minutes: number, reasons: string[]) => conflicts.push({ taskId: task.id, title: task.title, unscheduledMinutes: minutes, reasonCodes: reasons });
  while (pending.length) {
    const ready = pending.findIndex(task => task.dependencies.every(id => completion.has(id)));
    if (ready < 0) { pending.forEach(task => fail(task, task.minutes, ["blocked_dependency"])); break; }
    const task = pending.splice(ready, 1)[0];
    const accounted = preserved.filter(block => block.taskId === task.id && (block.completed || block.startedAt || (block.locked && Date.parse(block.endsAt) > floor)));
    const remaining = Math.max(0, task.minutes - accounted.reduce((sum, block) => sum + duration(block), 0));
    let cursor = Math.max(floor, Date.parse(task.earliestStart ?? "") || floor, ...task.dependencies.map(id => completion.get(id) ?? floor));
    const rawDue = Date.parse(task.dueAt ?? "");
    const deadline = Number.isFinite(rawDue) ? rawDue < floor ? floor + 7 * 24 * 60 * minute : rawDue : horizon;
    if (!remaining) { completion.set(task.id, Math.max(cursor, ...accounted.map(block => Date.parse(block.endsAt)))); continue; }
    const maximum = Math.max(5, Math.min(task.maxSessionMinutes, preferences.maxSessionMinutes));
    const minimum = Math.min(maximum, Math.max(20, task.minSessionMinutes));
    const count = task.splittable ? Math.ceil(remaining / maximum) : 1;
    const base = Math.floor(remaining / count / 5) * 5;
    const sessions = Array.from({ length: count }, () => base);
    let rest = remaining - base * count;
    for (let i = 0; rest > 0; i = (i + 1) % count) { const add = Math.min(5, rest); sessions[i] += add; rest -= add; }
    if (task.splittable && sessions.some(value => value < minimum || value > maximum)) { fail(task, remaining, ["session_limits_infeasible"]); continue; }
    const candidates = (minutes: number, after: number, busy: Window[]) => {
      const values = new Set<number>();
      for (const window of windows) {
        for (let start = Math.ceil(Math.max(after, window.start) / (5 * minute)) * 5 * minute; start + minutes * minute <= Math.min(window.end, deadline, horizon); start += 5 * minute) {
          if (!busy.some(item => start < item.end && start + minutes * minute > item.start)) values.add(start);
        }
      }
      return [...values].sort((a, b) => a - b);
    };
    let scheduled = 0;
    for (let index = 0; index < sessions.length; index++) {
      const minutes = sessions[index];
      const available = candidates(minutes, cursor, occupied);
      if (!available.length) { fail(task, remaining - scheduled, task.dueAt ? ["deadline_impossible", "insufficient_capacity"] : ["insufficient_capacity"]); break; }
      const balanced = task.splittable && (style === "balanced" || (style === "mixed" && index > 0));
      const dayLoads = new Map<string, number>();
      for (const block of blocks.filter(block => block.taskId && !block.completed)) {
        const day = dayKey(block.startsAt, timezone);
        dayLoads.set(day, (dayLoads.get(day) ?? 0) + duration(block));
      }
      const loads = new Map(available.map(start => [start, dayLoads.get(dayKey(new Date(start), timezone)) ?? 0]));
      const dailyLoad = (start: number) => loads.get(start) ?? 0;
      const stable = resetStyle ? undefined : previous.find(block => block.taskId === task.id && block.sessionIndex === index && available.includes(Date.parse(block.startsAt)) && duration(block) === minutes);
      let start = stable ? Date.parse(stable.startsAt) : [...available].sort((a, b) => (balanced ? dailyLoad(a) - dailyLoad(b) : 0) || a - b)[0];
      if (balanced) {
        const trial = [...occupied, { start, end: start + minutes * minute + gap }];
        let after = start + minutes * minute + gap;
        const fits = sessions.slice(index + 1).every(length => {
          const next = candidates(length, after, trial)[0];
          if (next === undefined) return false;
          after = next + length * minute + gap;
          trial.push({ start: next, end: after });
          return true;
        });
        if (!fits) start = available[0];
      }
      const end = start + minutes * minute;
      blocks.push({ id: stable && Date.parse(stable.startsAt) === start ? stable.id : `local:${task.id}:${index}:${start}`, taskId: task.id, title: task.title, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), kind: "study", completed: false, locked: false, sessionIndex: index, location: task.location, reasonCodes: ["feasible_window", style, ...(rawDue < floor ? ["overdue_recovery"] : [])] });
      occupied.push({ start:start - gap, end: end + gap });
      cursor = end + gap;
      scheduled += minutes;
      if (index === sessions.length - 1) completion.set(task.id, end);
    }
  }
  blocks.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id));
  return { blocks, conflicts };
}
