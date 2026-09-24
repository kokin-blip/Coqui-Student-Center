import { describe, expect, it } from "vitest";
import { compareSemester } from "../src/features/semester/semesterComparison";

describe("semester comparison", () => {
  const term = { startsOn:"2026-08-24", endsOn:"2026-09-06" };
  it("counts recurring class time, campus days, idle gaps, and overlaps", () => {
    const meetings = [
      { courseId:"biology", weekdays:[1,3], startsAtLocal:"09:00", endsAtLocal:"10:00", modality:"in_person" as const },
      { courseId:"math", weekdays:[1], startsAtLocal:"10:30", endsAtLocal:"11:30", modality:"online" as const },
      { courseId:"biology", weekdays:[3], startsAtLocal:"09:45", endsAtLocal:"10:30", modality:"hybrid" as const },
    ];
    expect(compareSemester(meetings, [{ id:"rule", kind:"work", label:"Shift", weekday:1, startsAtLocal:"09:30", endsAtLocal:"10:30" }], term, 20, [
      {courseId:"biology",completed:false,dueAt:"2026-08-31T12:00:00Z",minutes:90},
      {courseId:"math",completed:true,dueAt:"2026-08-31T12:00:00Z",minutes:60},
      {courseId:"other",completed:false,dueAt:"2026-08-31T12:00:00Z",minutes:120},
    ])).toEqual({
      classMinutes:225, gapMinutes:30, classConflictMinutes:15, rhythmConflictMinutes:30, campusDays:2, commuteMinutes:80, knownWorkMinutes:90,
    });
  });
  it("counts rotating classes only in their active weeks", () => {
    expect(compareSemester([{courseId:"biology",weekdays:[1],startsAtLocal:"09:00",endsAtLocal:"10:00",modality:"in_person",rotationIntervalWeeks:2,rotationOffsetWeeks:1}], [], term, 20, [])).toMatchObject({classMinutes:30,campusDays:.5,commuteMinutes:20});
  });
  it("does not count online meetings as campus days or commute", () => {
    expect(compareSemester([{courseId:"math",weekdays:[2], startsAtLocal:"12:00", endsAtLocal:"13:00", modality:"online"}], [], term, 20, [])).toMatchObject({campusDays:0,commuteMinutes:0,classConflictMinutes:0});
  });
});
