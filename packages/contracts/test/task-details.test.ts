import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TaskDetailsInput,
  TaskDetails,
  TaskActivityPage,
} from "../src/index.js";

const id = "00000000-0000-4000-8000-000000000001";
const input = {
  expectedRevision: 0,
  description: "Private notes",
  tags: ["Homework"],
  progress: "in_progress",
  subtasks: [{ id, title: "First step", completed: true }],
};
test("task details require revisions and unique, bounded metadata", () => {
  assert.equal(TaskDetailsInput.parse(input).progress, "in_progress");
  for (const invalid of [
    { ...input, expectedRevision: -1 },
    { ...input, expectedRevision: undefined },
    { ...input, tags: ["one", " ONE "] },
    { ...input, subtasks: [input.subtasks[0], input.subtasks[0]] },
    { ...input, description: "a".repeat(20_001) },
    { ...input, progress: "completed" },
    { ...input, completed: true },
    { ...input, attachments: [] },
  ])
    assert.equal(TaskDetailsInput.safeParse(invalid).success, false);
});
test("details and activity have explicit local metadata and stable page cursors", () => {
  const { expectedRevision, ...fields } = input;
  assert.equal(
    TaskDetails.parse({
      taskId: id,
      revision: expectedRevision,
      ...fields,
      attachments: [],
    }).subtasks.length,
    1,
  );
  assert.equal(
    TaskActivityPage.parse({
      entries: [
        {
          sequence: 3,
          taskId: id,
          kind: "task_received",
          origin: "received",
          createdAt: "2026-09-02T09:00:00-07:00",
        },
      ],
      nextCursor: 3,
    }).nextCursor,
    3,
  );
  assert.equal(
    TaskActivityPage.safeParse({ entries: [], nextCursor: 0 }).success,
    false,
  );
});
