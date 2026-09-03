import { createContext, useContext, useState, type ReactNode } from "react";
import { createPreviewTaskStore, type TaskDetails } from "./taskDetailsApi";

function createSession() {
  return {
    drafts: new Map<string, TaskDetails>(),
    preview: createPreviewTaskStore(),
  };
}
const TaskDetailsContext = createContext<ReturnType<
  typeof createSession
> | null>(null);

// Mounted only inside the unlocked app. Mode/route changes keep unsaved drafts;
// locking, deleting the profile, or restoring a backup discards this session.
export function TaskDetailsSession({ children }: { children: ReactNode }) {
  const [session] = useState(createSession);
  return (
    <TaskDetailsContext.Provider value={session}>
      {children}
    </TaskDetailsContext.Provider>
  );
}
export function useTaskDetailsSession() {
  const session = useContext(TaskDetailsContext);
  if (!session) throw new Error("Task details require an unlocked session");
  return session;
}
