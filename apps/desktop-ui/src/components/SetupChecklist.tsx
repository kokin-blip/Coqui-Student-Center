import { BookOpen, Check, Clock3, FileUp, ListTodo, X } from "lucide-react";
import { WorkspaceSnapshot } from "../native";

const DISMISS_KEY = "coqui.setupChecklist.dismissed";

export const isSetupChecklistDismissed = () => {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "true";
  } catch {
    return false;
  }
};

export const rememberDismissal = () => {
  try {
    window.localStorage.setItem(DISMISS_KEY, "true");
  } catch {
    // Dismissal is cosmetic. A blocked storage API must never break the view.
  }
};

/**
 * Shown on Today until the student has the three things the planner needs to be
 * useful. Onboarding no longer demands any of them, so this is where that work
 * gets picked back up.
 */
export function SetupChecklist({
  workspace,
  onOpenCourses,
  onAddTask,
  onImport,
  onDismiss,
}: {
  workspace: WorkspaceSnapshot;
  onOpenCourses: () => void;
  onAddTask: () => void;
  onImport: () => void;
  onDismiss: () => void;
}) {
  const items = [
    {
      id: "course",
      icon: <BookOpen />,
      title: "Add your first class",
      detail: "Courses give every assignment a home.",
      done: workspace.courses.length > 0,
      action: onOpenCourses,
      actionLabel: "Add a course",
    },
    {
      id: "meeting",
      icon: <Clock3 />,
      title: "Add your class times",
      detail: "Coqui plans around the hours you are already booked.",
      done: workspace.classMeetings.length > 0,
      action: onOpenCourses,
      actionLabel: "Add class times",
    },
    {
      id: "task",
      icon: <ListTodo />,
      title: "Add an assignment or exam",
      detail: "One deadline is enough to get a real plan.",
      done: workspace.tasks.length > 0,
      action: onAddTask,
      actionLabel: "Add work",
    },
  ];
  const remaining = items.filter((item) => !item.done);
  if (remaining.length === 0) return null;
  const next = remaining[0];

  return (
    <section className="setup-checklist" aria-labelledby="setup-checklist-title">
      <header>
        <div>
          <strong id="setup-checklist-title">Finish setting up</strong>
          <small>
            {items.length - remaining.length} of {items.length} done · you can do
            these in any order
          </small>
        </div>
        <button
          className="icon-btn"
          aria-label="Dismiss setup checklist"
          onClick={() => {
            rememberDismissal();
            onDismiss();
          }}
        >
          <X />
        </button>
      </header>
      <ol>
        {items.map((item) => (
          <li key={item.id} className={item.done ? "done" : ""}>
            <span className="setup-checklist-mark" aria-hidden="true">
              {item.done ? <Check /> : item.icon}
            </span>
            <span className="setup-checklist-copy">
              <strong>{item.title}</strong>
              <small>{item.detail}</small>
            </span>
            {item.done ? (
              <span className="setup-checklist-state">Done</span>
            ) : (
              <button
                className={item.id === next.id ? "solid" : "outline"}
                onClick={item.action}
              >
                {item.actionLabel}
              </button>
            )}
          </li>
        ))}
      </ol>
      <button className="text-button setup-checklist-import" onClick={onImport}>
        <FileUp /> Or import a syllabus and review what Coqui finds
      </button>
    </section>
  );
}
