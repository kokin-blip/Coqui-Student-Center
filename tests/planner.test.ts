import assert from "node:assert/strict";
import test from "node:test";
import { generatePlan, recommendNext, replan } from "../lib/planner";

const tasks = [
  { id:"paper", title:"Draft paper", durationMinutes:60, dueAt:"2026-08-13T20:00:00.000Z", priority:5 as const, splittable:true },
  { id:"reading", title:"Read chapter", durationMinutes:30, dueAt:"2026-08-15T20:00:00.000Z", priority:3 as const, splittable:true },
];
const fixedBlocks = [{ id:"class", title:"Class", startsAt:"2026-08-12T10:00:00.000Z", endsAt:"2026-08-12T11:00:00.000Z", locked:true }];

test("planner is deterministic and never overlaps fixed work", () => {
  const input = { now:"2026-08-12T08:00:00.000Z", horizonEnd:"2026-08-14T21:00:00.000Z", tasks, fixedBlocks };
  const first = generatePlan(input);
  assert.deepEqual(first, generatePlan(input));
  assert.equal(first.conflicts.length, 0);
  const study = first.blocks.filter(block => block.taskId);
  assert.ok(study.every(block => Date.parse(block.endsAt) <= Date.parse(fixedBlocks[0].startsAt) || Date.parse(block.startsAt) >= Date.parse(fixedBlocks[0].endsAt)));
});

test("impossible work is reported instead of overlapped", () => {
  const result = generatePlan({ now:"2026-08-12T20:30:00.000Z", horizonEnd:"2026-08-12T21:00:00.000Z", tasks:[{...tasks[0],durationMinutes:120}], fixedBlocks:[] });
  assert.deepEqual(result.conflicts, [{ taskId:"paper", unscheduledMinutes:120, reason:"insufficient_capacity" }]);
});

test("next action fits the available window", () => {
  const result = recommendNext({ now:"2026-08-12T08:00:00.000Z", availableMinutes:35, tasks });
  assert.equal(result.action?.taskId, "reading");
});

test("replanning protects locked and past blocks", () => {
  const existing = [{...fixedBlocks[0],reasonCodes:["fixed_commitment" as const]}];
  const result = replan({ now:"2026-08-12T08:00:00.000Z", effectiveAt:"2026-08-12T11:30:00.000Z", horizonEnd:"2026-08-14T21:00:00.000Z", tasks, fixedBlocks:[], existingBlocks:existing });
  assert.ok(result.blocks.some(block => block.id === "class"));
});
