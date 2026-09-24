import { expect, test } from "vitest";
import { analyzeSemesterSchedule } from "../src/features/semester/scheduleAnalysis";
import type { PlanningPreferenceRecord, RhythmRuleRecord } from "../src/native";

const term = { startsOn: "2026-08-24", endsOn: "2026-08-30" };
const preferences: PlanningPreferenceRecord = { sleepStart: "23:00", sleepEnd: "07:00", maxSessionMinutes: 90, breakMinutes: 10, transitionMinutes: 5, defaultCommuteMinutes: 30, version: 1 };
const work: RhythmRuleRecord[] = [{ id: "work", kind: "work", weekday: 1, startsAtLocal: "09:30", endsAtLocal: "10:30", label: "Shift" }];

test("shows overlapping class, work, sleep, commute, and study capacity by day", () => {
  const result = analyzeSemesterSchedule([
    { courseId: "c1", weekdays: [1], startsAtLocal: "06:30", endsAtLocal: "10:00", modality: "in_person" },
    { courseId: "c2", weekdays: [1], startsAtLocal: "09:45", endsAtLocal: "11:00", modality: "online" },
  ], work, [{ weekday: 1, startsAtLocal: "08:00", endsAtLocal: "12:00" }], term, preferences,
  [{ courseId: "c1", completed: false, dueAt: "2026-08-27T12:00:00Z", minutes: 180 }]);
  expect(result.days[1]).toMatchObject({ classConflictMinutes: 15, rhythmConflictMinutes: 60, sleepConflictMinutes: 30, commuteMinutes: 60, studyMinutes: 60 });
  expect(result.weeklyStudyMinutes).toBe(60);
  expect(result.overloadMinutes).toBe(120);
  expect(result.warnings).toContain("Known assignment effort exceeds preferred study capacity");
});

test("reports missing inputs rather than claiming a schedule is feasible", () => {
  const result = analyzeSemesterSchedule([{ courseId: "c1", weekdays: [1], startsAtLocal: "09:00", endsAtLocal: "10:00", modality: "in_person" }], [], [], term, null, []);
  expect(result.weeklyStudyMinutes).toBeNull();
  expect(result.overloadMinutes).toBeNull();
  expect(result.missingInputs).toContain("Sleep and commute preferences");
  expect(result.missingInputs).toContain("Preferred study windows");
});

test("counts rotating sections only in their active week", () => {
  const result = analyzeSemesterSchedule([{ courseId: "c1", weekdays: [1], startsAtLocal: "12:00", endsAtLocal: "13:00", modality: "online", rotationIntervalWeeks: 2, rotationOffsetWeeks: 1 }], [], [{ weekday: 1, startsAtLocal: "12:00", endsAtLocal: "14:00" }], { startsOn: "2026-08-24", endsOn: "2026-09-06" }, preferences, []);
  expect(result.days[1].classMinutes).toBe(30);
  expect(result.days[1].studyMinutes).toBe(90);
});

test("dated work commitments reduce study capacity without double-counting class records", () => {
  const result = analyzeSemesterSchedule([{ courseId:"c1", weekdays:[1], startsAtLocal:"09:00", endsAtLocal:"10:00", modality:"online" }], [], [{ weekday:1, startsAtLocal:"08:00", endsAtLocal:"12:00" }], term, preferences, [], [
    { id:"work", title:"Shift", startsAt:"2026-08-24T17:00:00Z", endsAt:"2026-08-24T19:00:00Z", kind:"work", location:"", travelBeforeMinutes:0, travelAfterMinutes:0, protected:true, version:1, recordOrigin:"local" },
    { id:"class", title:"Duplicate class", startsAt:"2026-08-24T16:00:00Z", endsAt:"2026-08-24T17:00:00Z", kind:"class", location:"", travelBeforeMinutes:0, travelAfterMinutes:0, protected:true, version:1, recordOrigin:"local" },
  ], "America/Phoenix");
  expect(result.days[1].rhythmConflictMinutes).toBe(0);
  expect(result.days[1].studyMinutes).toBe(60);
});

test("flags unknown transfer time between different in-person class locations", () => {
  const result = analyzeSemesterSchedule([
    { courseId:"c1", weekdays:[1], startsAtLocal:"09:00", endsAtLocal:"10:00", modality:"in_person", location:"Tempe" },
    { courseId:"c2", weekdays:[1], startsAtLocal:"10:15", endsAtLocal:"11:00", modality:"in_person", location:"Downtown Phoenix" },
  ], [], [{ weekday:1, startsAtLocal:"12:00", endsAtLocal:"14:00" }], term, preferences, []);
  expect(result.missingInputs).toContain("Travel time between in-person class locations");
});
