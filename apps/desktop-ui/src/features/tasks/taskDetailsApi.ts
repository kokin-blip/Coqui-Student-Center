import { invoke } from "@tauri-apps/api/core";
import type {
  TaskDetails,
  TaskDetailsInput,
  TaskActivityPage,
} from "../../../../../packages/contracts/src/task-details";
export type {
  TaskDetails,
  TaskDetailsInput,
  TaskActivity,
  TaskAttachment,
  TaskActivityPage,
} from "../../../../../packages/contracts/src/task-details";

export const taskDetailsApi = {
  load: (taskId: string) => invoke<TaskDetails>("get_task_details", { taskId }),
  save: (taskId: string, input: TaskDetailsInput) =>
    invoke<TaskDetails>("update_task_details", { taskId, input }),
  activity: (taskId: string, before: number | null = null) =>
    invoke<TaskActivityPage>("get_task_activity", {
      taskId,
      before,
      limit: 20,
    }),
  attach: async (taskId: string, file: File, expectedRevision: number) => {
    if (!file.size || file.size > 25 * 1024 * 1024)
      throw new Error("Choose a non-empty file up to 25 MB.");
    return invoke<TaskDetails>("attach_task_file", {
      taskId,
      fileName: file.name,
      bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
      expectedRevision,
    });
  },
  detach: (taskId: string, documentId: string, expectedRevision: number) =>
    invoke<TaskDetails>("detach_task_file", {
      taskId,
      documentId,
      expectedRevision,
    }),
  preview: (taskId: string, documentId: string) =>
    invoke<{
      kind: "image" | "text" | "export_only";
      content?: string;
      truncated?: boolean;
    }>("preview_task_file", { taskId, documentId }),
  export: (taskId: string, documentId: string, path: string) =>
    invoke<void>("export_task_file", { taskId, documentId, path }),
};

// Synthetic browser preview only: never stores private task text in localStorage.
// A new provider/session creates a new store. Native persistence uses the encrypted DB.
export function createPreviewTaskStore() {
  const saved = new Map<string, TaskDetails>();
  const history = new Map<string, TaskActivityPage["entries"]>();
  let sequence = 0;
  return {
    async load(taskId: string): Promise<TaskDetails> {
      return structuredClone(
        saved.get(taskId) ?? {
          taskId,
          revision: 0,
          description: "",
          tags: [],
          progress: "todo",
          subtasks: [],
          attachments: [],
        },
      );
    },
    async save(taskId: string, input: TaskDetailsInput): Promise<TaskDetails> {
      const current = await this.load(taskId);
      if (current.revision !== input.expectedRevision)
        throw new Error(
          "Task details changed. Reload and review the latest version before saving.",
        );
      const { expectedRevision, ...fields } = input;
      if (
        JSON.stringify(fields) ===
        JSON.stringify({
          description: current.description,
          tags: current.tags,
          progress: current.progress,
          subtasks: current.subtasks,
        })
      )
        return current;
      const next = { ...current, ...fields, revision: expectedRevision + 1 };
      saved.set(taskId, structuredClone(next));
      history.set(taskId, [
        {
          taskId,
          sequence: ++sequence,
          kind: "task_updated",
          origin: "local",
          createdAt: new Date().toISOString(),
        },
        ...(history.get(taskId) ?? []),
      ]);
      return next;
    },
    async activity(
      taskId: string,
      before: number | null = null,
    ): Promise<TaskActivityPage> {
      const entries = (history.get(taskId) ?? []).filter(
        (entry) => before === null || entry.sequence < before,
      );
      return {
        entries: entries.slice(0, 20),
        nextCursor: entries.length > 20 ? entries[19].sequence : null,
      };
    },
  };
}
