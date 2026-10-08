import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as native from "../src/native";
import { CalendarView } from "../src/components/CalendarView";
import { TaskDetailsSession } from "../src/features/tasks/TaskDetailsSession";
import { generateLocalSchedule } from "../src/features/planning/localScheduler";

const now = new Date("2026-10-05T07:00:00Z");
let api: typeof native;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.resetModules();
  api = await import("../src/native");
  const workspace = await api.getLocalWorkspace();
  // Remove sample records so scheduling assertions concern only the new task.
  for (const task of workspace.tasks) await api.deleteLocalTask(task.id, task.version);
  for (const item of workspace.commitments) await api.deleteCommitment(item.id, item.version);
  await api.updateStudentProfile({ name: "Calendar test", timezone: "UTC", expectedVersion: workspace.profile!.version });
  await api.updatePlanningPreferences({ schedulingStyle: "earliest", sleepStart: "23:00", sleepEnd: "07:00", maxSessionMinutes: 60, breakMinutes: 10, transitionMinutes: 10, defaultCommuteMinutes: 0, availability: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startsAtLocal: "08:00", endsAtLocal: "21:00" })) });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function task(minutes = 60, dueAt?: string) {
  const workspace = await api.createLocalTask({ title: "Calendar work", kind: "assignment", minutes, priority: 3, academicRisk: 0, energyDemand: "medium", location: "", splittable: true, minSessionMinutes: 20, maxSessionMinutes: 60, dependencies: [], dueAt });
  const item = workspace.tasks.find(item => item.title === "Calendar work")!;
  return { task: item, block: (await api.getTaskPlan(item.id)).sessions[0] };
}

test("preview resize reschedules the remaining effort and full undo restores the plan", async () => {
  const { task: item, block } = await task();
  const before = await api.getCalendarAgenda("2026-10-05");
  await api.movePlanBlock(block.id, block.startsAt, new Date(Date.parse(block.startsAt) + 30 * 60000).toISOString());
  const plan = await api.getTaskPlan(item.id);
  expect(plan.sessions).toHaveLength(2);
  expect(plan.unscheduledMinutes).toBe(0);
  expect(plan.sessions.find(item => item.id === block.id)).toMatchObject({ locked: true, reasonCodes: ["manual_calendar_move"] });
  expect((await api.getLocalWorkspace()).tasks[0]).toEqual(item);
  await api.undoCalendarChange();
  expect(await api.getCalendarAgenda("2026-10-05")).toEqual(before);
  await expect(api.undoCalendarChange()).rejects.toThrow("no calendar change");
});

test("preview shortening reports shortfall immediately; lengthening removes excess work", async () => {
  const { task: item, block } = await task(60, "2026-10-05T09:00:00Z");
  await api.movePlanBlock(block.id, block.startsAt, "2026-10-05T08:30:00Z");
  expect((await api.getTaskPlan(item.id)).unscheduledMinutes).toBe(30);
  expect((await api.getCalendarAgenda("2026-10-05")).overloadConflicts[0].description).toContain("30 unscheduled minutes");
  await api.undoCalendarChange();
  await api.deleteLocalTask(item.id, item.version);
  const next = await task(120);
  await api.movePlanBlock(next.block.id, "2026-10-05T12:00:00Z", "2026-10-05T13:30:00Z");
  const plan = await api.getTaskPlan(next.task.id);
  expect(plan.unscheduledMinutes).toBe(0);
  expect(plan.sessions.map(b => (Date.parse(b.endsAt)-Date.parse(b.startsAt))/60000).sort()).toEqual([30,90]);
  expect(new Set(plan.sessions.map(b => b.id)).size).toBe(plan.sessions.length);
  expect(plan.sessions.find(b => b.id === next.block.id)).toMatchObject({ startsAt: "2026-10-05T12:00:00.000Z", endsAt: "2026-10-05T13:30:00.000Z", locked: true, reasonCodes: ["manual_calendar_move"] });
});

test.each(["commitment", "input", "started", "completed", "elapsed"])("preview undo rejects %s changes", async change => {
  const { task: item, block } = await task();
  await api.movePlanBlock(block.id, "2026-10-05T12:00:00Z", "2026-10-05T13:00:00Z");
  if (change === "commitment") await api.createCommitment({ title: "New commitment", startsAt: block.startsAt, endsAt: block.endsAt, kind: "work", location: "", travelBeforeMinutes: 0, travelAfterMinutes: 0, protected: true });
  if (change === "input") await api.updateLocalTask(item.id, { ...item, minutes: 90, expectedVersion: item.version });
  if (change === "started") await api.startPlanBlock(block.id);
  if (change === "completed") await api.toggleTask(item.id);
  if (change === "elapsed") vi.setSystemTime(new Date("2026-10-05T08:01:00Z"));
  const before = await api.getCalendarAgenda("2026-10-05");
  await expect(api.undoCalendarChange()).rejects.toThrow(change === "elapsed" ? "elapsed" : "changed");
  expect(await api.getCalendarAgenda("2026-10-05")).toEqual(before);
});

test("preview holidays filter inclusive meeting dates using each meeting's timezone", async () => {
  const workspace = await api.getLocalWorkspace();
  workspace.tasks = []; workspace.classMeetings = [{ id: "daily", courseId: "course", termId: "term", timezone: "Asia/Tokyo", weekdays: [0,1,2,3,4,5,6], startsAtLocal: "00:30", endsAtLocal: "01:30", component: "lecture", location: "", modality: "in_person", rotationIntervalWeeks: 1, rotationOffsetWeeks: 0, version: 1 }];
  workspace.terms = [{ id: "term", name: "Fall", startsOn: "2026-08-01", endsOn: "2026-12-20", active: true, version: 1 }];
  for (const [termId, noClass, present] of [["term",true,false],[undefined,true,false],["other",true,true],["term",false,true]] as const) {
    workspace.academicEvents = [{ id: "break", termId, title: "Break", startsOn: "2026-10-05", endsOn: "2026-10-07", allDay: true, noClass, source: "user", version: 1 }];
    const outcome = generateLocalSchedule(workspace, [], new Date("2026-10-04T00:00:00Z"));
    for (const day of ["2026-10-05","2026-10-06","2026-10-07"]) expect(outcome.blocks.some(b => b.id === `class:daily:${day}`)).toBe(present);
    expect(outcome.blocks.some(b => b.id === "class:daily:2026-10-08")).toBe(true);
  }
  workspace.academicEvents[0] = { ...workspace.academicEvents[0], noClass: true, endsOn: "2026-10-05" };
  const singleDay = generateLocalSchedule(workspace, [], new Date("2026-10-04T00:00:00Z"));
  expect(singleDay.blocks.some(b => b.id === "class:daily:2026-10-05")).toBe(false);
  expect(singleDay.blocks.some(b => b.id === "class:daily:2026-10-06")).toBe(true);
});

test("Calendar keyboard resize and successful or rejected undo refresh the displayed agenda", async () => {
  const { block } = await task();
  // Components use the static native module; direct preview API tests use fresh instances.
  const before = await api.getCalendarAgenda("2026-10-05");
  const workspace = await api.getLocalWorkspace();
  vi.spyOn(native, "getLocalWorkspace").mockImplementation(() => api.getLocalWorkspace());
  vi.spyOn(native, "getCalendarAgenda").mockImplementation(start => api.getCalendarAgenda(start));
  vi.spyOn(native, "getDashboard").mockImplementation(() => api.getDashboard());
  const move = vi.spyOn(native, "movePlanBlock").mockImplementation((...args) => api.movePlanBlock(...args));
  const undo = vi.spyOn(native, "undoCalendarChange").mockImplementation(() => api.undoCalendarChange());
  const dashboard = vi.fn();
  render(<TaskDetailsSession><CalendarView onDashboard={dashboard} onImport={vi.fn()} onStudy={vi.fn()} onConnections={vi.fn()} /></TaskDetailsSession>);
  const session = await screen.findByRole("button", { name: /Calendar work,.*60 minutes/ });
  fireEvent.keyDown(session, { key: "ArrowUp", shiftKey: true });
  await waitFor(() => expect(dashboard).toHaveBeenCalled());
  expect(move).toHaveBeenCalledWith(block.id, block.startsAt, new Date(Date.parse(block.endsAt)-15*60000).toISOString());
  expect((await api.getTaskPlan(workspace.tasks[0].id)).unscheduledMinutes).toBe(15);
  fireEvent.click(screen.getByRole("button", { name: /Undo/i }));
  await waitFor(() => expect(undo).toHaveBeenCalledOnce());
  await screen.findByRole("button", { name: /Calendar work,.*60 minutes/ });
  expect(await api.getCalendarAgenda("2026-10-05")).toEqual(before);
  undo.mockRejectedValue(new Error("Your schedule changed after this calendar edit. Undo would overwrite newer work."));
  fireEvent.click(screen.getByRole("button", { name: /Undo/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent("would overwrite newer work");
  expect(await api.getCalendarAgenda("2026-10-05")).toEqual(before);
});
