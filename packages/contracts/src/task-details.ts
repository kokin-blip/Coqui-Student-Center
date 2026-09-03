import { z } from "zod";

// Device-local encrypted data. These are intentionally not replicated entities.
export const TaskSubtask = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(500),
    completed: z.boolean(),
  })
  .strict();
export type TaskSubtask = z.infer<typeof TaskSubtask>;

export const TaskAttachment = z.object({
  documentId: z.string().uuid(),
  fileName: z.string().min(1).max(255),
  mime: z.string().min(1),
  attachedAt: z.string().datetime({ offset: true }),
});
export type TaskAttachment = z.infer<typeof TaskAttachment>;

const editable = {
  description: z.string().max(20_000),
  tags: z
    .array(z.string().trim().min(1).max(60))
    .max(30)
    .refine(
      (tags) =>
        new Set(tags.map((tag) => tag.toLowerCase())).size === tags.length,
      "Tags must be unique",
    ),
  progress: z.enum(["todo", "in_progress"]),
  subtasks: z
    .array(TaskSubtask)
    .max(200)
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
      "Subtask IDs must be unique",
    ),
};
export const TaskDetails = z.object({
  taskId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  ...editable,
  attachments: z.array(TaskAttachment).max(100),
});
export type TaskDetails = z.infer<typeof TaskDetails>;
export const TaskDetailsInput = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    ...editable,
  })
  .strict();
export type TaskDetailsInput = z.infer<typeof TaskDetailsInput>;

export const TaskActivity = z.object({
  sequence: z.number().int().positive(),
  taskId: z.string().uuid(),
  kind: z.enum([
    "task_created",
    "task_completed",
    "task_updated",
    "task_received",
    "description_updated",
    "tags_updated",
    "progress_updated",
    "subtasks_updated",
    "attachment_added",
    "attachment_removed",
  ]),
  origin: z.enum(["local", "received"]),
  createdAt: z.string().datetime({ offset: true }),
});
export type TaskActivity = z.infer<typeof TaskActivity>;
export const TaskActivityPage = z.object({
  entries: z.array(TaskActivity).max(100),
  nextCursor: z.number().int().positive().nullable(),
});
export type TaskActivityPage = z.infer<typeof TaskActivityPage>;
