import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as native from "../src/native";
import { generateLocalSchedule } from "../src/features/planning/localScheduler";
import { TodayTaskInspector } from "../src/features/today/TodayTaskInspector";
import { LocalScheduling } from "../src/features/planning/LocalScheduling";
import { TaskDetailsSession } from "../src/features/tasks/TaskDetailsSession";
import { dayKey } from "../src/features/today/todayModel";

const now = new Date("2026-10-05T07:00:00-07:00");
async function fixture() {
  const workspace = await native.getLocalWorkspace();
  workspace.profile!.timezone = "America/Phoenix";
  workspace.tasks = [{ ...workspace.tasks[0], id:"paper", title:"Paper", minutes:180, dueAt:"2026-10-09T23:59:00-07:00", completed:false, dependencies:[], maxSessionMinutes:60 }];
  workspace.preferences = { sleepStart:"23:00", sleepEnd:"07:00", maxSessionMinutes:60, breakMinutes:10, transitionMinutes:10, defaultCommuteMinutes:15, schedulingStyle:"mixed", version:1 };
  workspace.availability = Array.from({length:7}, (_,weekday) => ({weekday, startsAtLocal:"08:00", endsAtLocal:"18:00"}));
  workspace.commitments = [];
  workspace.classMeetings = [];
  workspace.academicEvents = [];
  workspace.rhythmRules = [];
  return workspace;
}
afterEach(() => vi.restoreAllMocks());

describe("local assignment scheduling", () => {
  test.each(["mixed", "balanced", "earliest"] as const)("%s respects classes and travel and preserves all effort", async style => {
    const workspace = await fixture();
    workspace.preferences!.schedulingStyle = style;
    workspace.commitments = [{ id:"class", title:"Class", startsAt:"2026-10-05T08:00:00-07:00", endsAt:"2026-10-05T09:00:00-07:00", kind:"class", location:"campus", travelBeforeMinutes:15, travelAfterMinutes:15, protected:true, version:1, recordOrigin:"user" }];
    const outcome = generateLocalSchedule(workspace, [], now);
    const sessions = outcome.blocks.filter(block => block.taskId);
    expect(outcome.conflicts).toEqual([]);
    expect(sessions.reduce((sum, block) => sum + (Date.parse(block.endsAt)-Date.parse(block.startsAt))/60000, 0)).toBe(180);
    expect(sessions.every(block => Date.parse(block.startsAt) >= Date.parse("2026-10-05T09:25:00-07:00"))).toBe(true);
    expect(new Set(sessions.map(block => dayKey(block.startsAt, "America/Phoenix"))).size).toBe(style === "earliest" ? 1 : 3);
  });
  test("balanced scheduling compresses sessions before a tight deadline", async () => {
    const workspace = await fixture();
    workspace.tasks[0].dueAt = "2026-10-06T10:30:00-07:00";
    workspace.availability.forEach(rule => rule.endsAtLocal = "10:30");
    workspace.preferences!.schedulingStyle = "balanced";
    const outcome = generateLocalSchedule(workspace, [], now);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.blocks.filter(block => block.taskId)).toHaveLength(3);
  });
  test("blocked dependencies, impossible capacity, and invalid session limits stay explicit", async () => {
    const workspace = await fixture();
    workspace.tasks[0].dependencies = ["missing"];
    expect(generateLocalSchedule(workspace, [], now).conflicts[0].reasonCodes).toContain("blocked_dependency");
    workspace.tasks[0].dependencies = [];
    workspace.tasks[0].dueAt = "2026-10-05T08:10:00-07:00";
    expect(generateLocalSchedule(workspace, [], now).conflicts[0].unscheduledMinutes).toBe(180);
    workspace.tasks[0].minutes = 10;
    expect(generateLocalSchedule(workspace, [], now).conflicts[0].reasonCodes).toContain("session_limits_infeasible");
  });
  test("started and manually locked sessions survive rescheduling without duplicate effort", async () => {
    const workspace = await fixture();
    workspace.preferences!.schedulingStyle = "earliest";
    const first = generateLocalSchedule(workspace, [], now);
    const sessions = first.blocks.filter(block => block.taskId);
    sessions[0].startedAt = now.toISOString();
    sessions[1].locked = true;
    workspace.preferences!.schedulingStyle = "balanced";
    const next = generateLocalSchedule(workspace, first.blocks, now, true);
    expect(next.blocks.find(block => block.id === sessions[0].id)).toEqual(sessions[0]);
    expect(next.blocks.find(block => block.id === sessions[1].id)).toEqual(sessions[1]);
    expect(next.blocks.filter(block => block.taskId)).toHaveLength(3);
  });
  test("overdue recovery preserves the deadline and dependencies wait for their prerequisite", async () => {
    const workspace = await fixture();
    workspace.tasks[0].dueAt = "2026-10-04T23:59:00-07:00";
    workspace.tasks.push({...workspace.tasks[0], id:"review", title:"Review", minutes:60, dueAt:undefined, dependencies:["paper"]});
    const outcome = generateLocalSchedule(workspace, [], now);
    const paper = outcome.blocks.filter(block => block.taskId === "paper");
    expect(paper.every(block => block.reasonCodes.includes("overdue_recovery"))).toBe(true);
    expect(workspace.tasks[0].dueAt).toBe("2026-10-04T23:59:00-07:00");
    expect(Date.parse(outcome.blocks.find(block => block.taskId === "review")!.startsAt)).toBeGreaterThanOrEqual(Date.parse(paper.at(-1)!.endsAt));
  });
  test("recommendations honor sleep, protected days, weekly classes, and DST", async () => {
    const workspace = await fixture();
    workspace.profile!.timezone = "America/New_York";
    workspace.preferences!.schedulingStyle = "earliest";
    workspace.tasks[0].dueAt = undefined;
    workspace.terms = [{ id:"term", name:"Fall", startsOn:"2026-08-01", endsOn:"2026-12-01", active:true, version:1 }];
    workspace.classMeetings = [{ id:"lecture", courseId:"course", termId:"term", timezone:"America/New_York", weekdays:[1], startsAtLocal:"08:00", endsAtLocal:"10:00", component:"lecture", location:"campus", modality:"in_person", rotationIntervalWeeks:1, rotationOffsetWeeks:0, version:1 }];
    workspace.academicEvents = [{ id:"holiday", title:"Break", startsOn:"2026-11-01", endsOn:"2026-11-01", allDay:true, noClass:true, source:"user", version:1 }];
    const outcome = generateLocalSchedule(workspace, [], new Date("2026-11-01T05:00:00Z"));
    const sessions = outcome.blocks.filter(block => block.taskId);
    expect(sessions[0].startsAt).toBe("2026-11-02T15:25:00.000Z");
    expect(outcome.conflicts).toEqual([]);
  });
});

test("inspector shows all recommended sessions and partial capacity outside the visible week", async () => {
  const workspace = await fixture();
  const outcome = generateLocalSchedule(workspace, [], now);
  vi.spyOn(native, "getTaskPlan").mockResolvedValue({sessions:outcome.blocks, unscheduledMinutes:20, reasonCodes:["insufficient_capacity"]});
  render(<TaskDetailsSession><TodayTaskInspector task={workspace.tasks[0]} workspace={workspace} blocks={[]} day="2026-10-20" timezone="America/Phoenix" busy={false} onClose={vi.fn()} onEdit={vi.fn()} onComplete={vi.fn()} onStart={vi.fn()} /></TaskDetailsSession>);
  expect(await screen.findByText(/Oct 5, 2026/)).toBeInTheDocument();
  expect(screen.getByText(/Oct 6, 2026/)).toBeInTheDocument();
  expect(screen.getByText(/Partially scheduled: 20 min remain/)).toBeInTheDocument();
  expect(screen.getByRole("button", {name:"Start focus"})).toBeEnabled();
});

test("the one-time style question saves only after the user chooses and disappears", async () => {
  const workspace = await fixture(); workspace.preferences!.schedulingStyle = null;
  const dashboard = await native.getDashboard();
  vi.spyOn(native, "getDashboard").mockResolvedValue(dashboard);
  vi.spyOn(native, "getLocalWorkspace").mockResolvedValue(workspace);
  const save = vi.spyOn(native, "updatePlanningPreferences").mockResolvedValue({...workspace, preferences:{...workspace.preferences!, schedulingStyle:"balanced"}});
  render(<LocalScheduling dashboard={dashboard} showChoice blocked={false} onDashboard={vi.fn()} />);
  const select = await screen.findByRole("combobox", {name:/Assignment scheduling/});
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(select, {target:{value:"balanced"}});
  fireEvent.click(screen.getByRole("button", {name:"Save scheduling style"}));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({schedulingStyle:"balanced", expectedVersion:1})));
  await waitFor(() => expect(screen.queryByRole("region", {name:"Choose assignment scheduling"})).not.toBeInTheDocument());
});
