import { expect, test } from "vitest";
import { completedStudyPlan, initialCompletionMomentum, recordTaskCompletion, weeklyGoalReached } from "../src/features/shell/completionMomentum";
import { getDashboard, type PlanBlock } from "../src/native";

const now = Date.parse("2026-09-22T12:00:00Z");

test("routine work stays quiet while major and early completion can celebrate", () => {
  const first = recordTaskCompletion(initialCompletionMomentum, { id:"one", kind:"reading" }, now, true, true);
  expect(first.reason).toBeNull();
  const major = recordTaskCompletion(first.state, { id:"two", kind:"project" }, now + 1000, true, true);
  expect(major.reason).toBe("major");
  const cooldown = recordTaskCompletion(major.state, { id:"three", kind:"exam" }, now + 2000, true, true);
  expect(cooldown.reason).toBeNull();
  const early = recordTaskCompletion(cooldown.state, { id:"four", kind:"homework", dueAt:"2026-09-27T12:00:00Z" }, now + 60_000, true, true);
  expect(early.reason).toBe("early");
  expect(recordTaskCompletion(early.state, { id:"four", kind:"homework" }, now + 120_000, true, true).newCompletion).toBe(false);
});

test("streaks need distinct recent tasks and respect the momentum switch", () => {
  let state = initialCompletionMomentum;
  for (const id of ["one", "two"]) state = recordTaskCompletion(state, { id, kind:"reading" }, now, true, true).state;
  expect(recordTaskCompletion(state, { id:"three", kind:"reading" }, now + 10_000, true, true).reason).toBe("streak");
  expect(recordTaskCompletion(state, { id:"three", kind:"reading" }, now + 10_000, true, false).reason).toBeNull();
  expect(recordTaskCompletion(state, { id:"three", kind:"reading" }, now + 21 * 60_000, true, true).reason).toBeNull();
});

test("visual feedback can be disabled without losing completion tracking", () => {
  const disabled = recordTaskCompletion(initialCompletionMomentum, { id:"paper", kind:"paper" }, now, false, true);
  expect(disabled.reason).toBeNull();
  expect(disabled.newCompletion).toBe(true);
  expect(recordTaskCompletion(disabled.state, { id:"paper", kind:"paper" }, now + 1000, true, true).reason).toBeNull();
});

test("the final persisted study session completes a nontrivial daily plan only once", async () => {
  const base = await getDashboard();
  const block = (id: string, taskId: string, completed: boolean): PlanBlock => ({
    id, taskId, startsAt:`2026-09-22T${id === "one" ? "09:00" : "11:00"}:00-07:00`,
    endsAt:`2026-09-22T${id === "one" ? "09:45" : "11:45"}:00-07:00`, title:id,
    kind:"study", completed, locked:false, sessionIndex:0, location:"", reasonCodes:[],
  });
  const before = { ...base, planDate:"2026-09-22", timezone:"America/Phoenix", blocks:[block("one", "task-one", true), block("two", "task-two", false)] };
  const after = { ...before, blocks:[block("one", "task-one", true), block("two", "task-two", true)] };
  expect(completedStudyPlan(before, after, "task-two")).toBe("2026-09-22");
  expect(completedStudyPlan(before, after, "other-task")).toBeNull();
  expect(completedStudyPlan(after, after, "task-two")).toBeNull();
  expect(completedStudyPlan({ ...before, blocks:[before.blocks[1]] }, { ...after, blocks:[after.blocks[1]] }, "task-two")).toBeNull();
  expect(completedStudyPlan(before, { ...after, blocks:[after.blocks[0]] }, "task-two")).toBeNull();
  const result = recordTaskCompletion(initialCompletionMomentum, { id:"task-two", kind:"reading" }, now, true, true, completedStudyPlan(before, after, "task-two"));
  expect(result.reason).toBe("plan");
  expect(recordTaskCompletion(result.state, { id:"another", kind:"reading" }, now + 60_000, true, true, "2026-09-22").reason).toBeNull();
});

test("an opted-in weekly goal counts persisted completions in the student's local week only once", () => {
  const tasks = [
    {completed:true,completedAt:"2026-09-21T18:00:00Z"},
    {completed:true,completedAt:"2026-09-22T12:00:00Z"},
    {completed:true,completedAt:"2026-09-21T06:00:00Z"},
    {completed:false,completedAt:"2026-09-22T11:00:00Z"},
  ];
  expect(weeklyGoalReached(tasks,0,now,"America/Phoenix","")).toBeNull();
  expect(weeklyGoalReached(tasks,2,now,"America/Phoenix","")).toBe("2026-09-21");
  expect(weeklyGoalReached(tasks,2,now,"America/Phoenix","2026-09-21")).toBeNull();
  expect(weeklyGoalReached(tasks,3,now,"America/Phoenix","")).toBeNull();
  expect(weeklyGoalReached(tasks,3,now,"UTC","")).toBe("2026-09-21");
  const reached = recordTaskCompletion(initialCompletionMomentum,{id:"second",kind:"reading"},now,true,true,null,"2026-09-21");
  expect(reached.reason).toBe("weekly");
  expect(recordTaskCompletion(reached.state,{id:"third",kind:"reading"},now+1000,true,true,null,"2026-09-21").reason).toBeNull();
});
