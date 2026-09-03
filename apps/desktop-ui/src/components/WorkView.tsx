import { useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, ListChecks, Plus, Upload, X } from "lucide-react";
import {
  createLocalTask,
  deleteLocalTask,
  getDashboard,
  getLocalWorkspace,
  updateLocalTask,
  toggleTask,
} from "../native";
import type { TaskInput, TaskRecord, WorkspaceSnapshot } from "../native";
import type { WorkspaceRouteProps } from "./workspaceTypes";
import { TaskInspector } from "../features/tasks/TaskInspector";
import { useTaskDetailsSession } from "../features/tasks/TaskDetailsSession";
import { emptyTask, taskInput } from "../features/tasks/taskEditorModel";
import { dayKey, dueLabel, priorityLabel } from "../features/today/todayModel";
import "../features/tasks/work.css";
import type { InterfaceMode } from "../features/shell/interfacePreferences";
import { Modal } from "./Modal";

export type WorkFilter =
  | "all"
  | "high"
  | "inbox"
  | "upcoming"
  | "overdue"
  | "exams"
  | "completed";

export function WorkView({
  initialTaskId,
  initialFilter,
  onSelectTask,
  onFilterChange,
  mode = "comfy",
  onDashboard,
  onImport,
  onStudy,
}: WorkspaceRouteProps & {
  initialTaskId?: string | null;
  initialFilter?: WorkFilter;
  onSelectTask?: (id: string | null) => void;
  onFilterChange?: (filter: WorkFilter) => void;
  mode?: InterfaceMode;
}) {
  const session = useTaskDetailsSession();
  const draft = session.workDrafts.get(initialTaskId ?? "new");
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [filter, setFilter] = useState<WorkFilter | "all" | "high">(
    (initialFilter ?? session.workFilter) as WorkFilter | "all" | "high",
  );
  const [task, setTaskState] = useState<TaskInput>(
    () => draft?.input ?? emptyTask(),
  );
  const [editing, setEditing] = useState<TaskRecord | null>(
    draft?.record ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [wide, setWide] = useState(window.innerWidth >= 1440);
  const [inspectorOpen, setInspectorOpen] = useState(Boolean(initialTaskId));
  const editorRef = useRef<HTMLElement>(null);
  const [focusEditor, setFocusEditor] = useState(0);
  useEffect(() => {
    if (!focusEditor || (mode === "compact" && !wide)) return;
    editorRef.current?.querySelector("input")?.focus();
  }, [focusEditor, mode, wide]);
  useEffect(() => {
    const resize = () => setWide(window.innerWidth >= 1440);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const setTask: React.Dispatch<React.SetStateAction<TaskInput>> = (next) => {
    const value = typeof next === "function" ? next(task) : next;
    session.workDrafts.set(editing?.id ?? "new", {
      input: value,
      record: editing,
    });
    setTaskState(value);
  };

  useEffect(() => {
    let active = true;
    void getLocalWorkspace()
      .then((value) => {
        if (active) {
          setWorkspace(value);
        }
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [reload]);

  useEffect(() => {
    if (!workspace || !initialTaskId || editing?.id === initialTaskId) return;
    const selected = workspace.tasks.find((item) => item.id === initialTaskId);
    if (selected) edit(selected);
  }, [workspace, initialTaskId, editing?.id]);

  useEffect(() => {
    if (initialFilter) setFilter(initialFilter);
  }, [initialFilter]);
  useEffect(() => {
    session.workFilter = filter;
  }, [filter, session]);

  const apply = async (operation: () => Promise<WorkspaceSnapshot>) => {
    setBusy(true);
    setError("");
    try {
      const updated = await operation();
      setWorkspace(updated);
      // A refresh failure must not masquerade as a failed write and invite a duplicate.
      try {
        onDashboard(await getDashboard());
      } catch {
        setError(
          "Saved, but the dashboard could not refresh. Reopen Today to retry.",
        );
      }
      return updated;
    } catch (reason) {
      setError(String(reason));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const visibleTasks = useMemo(
    () =>
      workspace?.tasks.filter((item) => {
        const overdue =
          Boolean(item.dueAt) &&
          (/^\d{4}-\d{2}-\d{2}$/.test(item.dueAt!)
            ? item.dueAt! <
              dayKey(new Date(), workspace.profile?.timezone ?? "UTC")
            : new Date(item.dueAt!).getTime() < Date.now()) &&
          !item.completed;
        if (filter === "completed") return item.completed;
        if (filter === "all") return true;
        if (filter === "high") return !item.completed && item.priority >= 4;
        if (filter === "exams") return item.kind === "exam" && !item.completed;
        if (filter === "overdue") return overdue;
        if (filter === "inbox") return !item.completed && !item.dueAt;
        return !item.completed && !overdue;
      }) ?? [],
    [filter, workspace],
  );

  const edit = (value: TaskRecord) => {
    setFocusEditor(value => value + 1);
    setInspectorOpen(true);
    const savedDraft = session.workDrafts.get(value.id);
    setEditing(savedDraft?.record ?? value);
    setTaskState(savedDraft?.input ?? taskInput(value));
    onSelectTask?.(value.id);
  };

  const resetEditor = () => {
    session.workDrafts.delete(editing?.id ?? "new");
    setEditing(null);
    setTaskState(session.workDrafts.get("new")?.input ?? emptyTask());
    onSelectTask?.(null);
  };
  const save = async () => {
    const submitted = task;
    const key = editing?.id ?? "new";
    const updated = await apply(() =>
      editing ? updateLocalTask(editing.id, task) : createLocalTask(task),
    );
    if (!updated) return;
    if (session.workDrafts.get(key)?.input === submitted)
      session.workDrafts.delete(key);
    if (editing) {
      const saved = updated.tasks.find((item) => item.id === editing.id);
      if (saved) {
        setEditing(saved);
        setTaskState(taskInput(saved));
      }
    } else resetEditor();
  };

  if (!workspace)
    return (
      <div className="content workspace-page">
        <div className="loading">
          <strong>Loading your encrypted local records…</strong>
          {error && (
            <>
              <p role="alert">{error}</p>
              <button
                onClick={() => {
                  setError("");
                  setReload((value) => value + 1);
                }}
              >
                Retry loading Work
              </button>
            </>
          )}
        </div>
      </div>
    );

  const inspector = (
      <TaskInspector
        editorRef={editorRef}
      workspace={workspace}
      task={task}
      editing={editing}
      busy={busy}
      setTask={setTask}
      reset={resetEditor}
      save={() => void save()}
    />
  );

  return (
    <section
      className="content workspace-page mode-assignments"
      data-route="work"
      aria-label="Work workspace"
    >
      <div className="page-head">
        <div>
          <h1>Work</h1>
          <p>Your assignments, exams, and next steps.</p>
        </div>
        <div className="page-head-actions">
          <button className="outline" onClick={onImport}>
            <Upload />
            Import
          </button>
          <button className="outline" onClick={onStudy}>
            Open Study
          </button>
          <button
            className="solid"
            onClick={() => {
              setFocusEditor(value => value + 1);
              setInspectorOpen(true);
              setEditing(null);
              setTaskState(session.workDrafts.get("new")?.input ?? emptyTask());
              onSelectTask?.(null);
            }}
          >
            <Plus /> New task
          </button>
          {mode === "compact" && !wide && (
            <button className="outline" onClick={() => setInspectorOpen(true)}>
              Open task inspector
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="alert" role="alert">
          <CircleAlert />
          <span>{error}</span>
          {editing && <button disabled={busy} onClick={async () => {
            if (!window.confirm("Discard your unsaved task fields and reload the saved version? Your separate detail draft is kept.")) return;
            setBusy(true);
            try {
              const latest = await getLocalWorkspace();
              const record = latest.tasks.find(item => item.id === editing.id);
              setWorkspace(latest);
              if (!record) { setError("This task is no longer available. Your draft has not been discarded."); return; }
              session.workDrafts.delete(record.id);
              setEditing(record); setTaskState(taskInput(record)); setError("");
            } catch (reason) { setError(String(reason)); }
            finally { setBusy(false); }
          }}>Reload saved task</button>}
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <X />
          </button>
        </div>
      )}
      <div className="workspace-grid academics assignments">
        <section className="workspace-panel work-list-panel">
          <div className="section-head">
            <h2>Assignments & exams</h2>
            <span>
              {workspace.tasks.filter((item) => !item.completed).length} open
            </span>
          </div>
          <div
            className="segmented work-tabs"
            role="tablist"
            aria-label="Work filters"
          >
            {(
              [
                "all",
                "high",
                "inbox",
                "upcoming",
                "overdue",
                "exams",
                "completed",
              ] as const
            ).map((value) => (
              <button
                role="tab"
                aria-selected={filter === value}
                className={filter === value ? "active" : ""}
                key={value}
                onClick={() => {
                  setFilter(value);
                  onFilterChange?.(value);
                }}
              >
                {value[0].toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
          {visibleTasks.length ? (
            <div
              className="work-table-scroll"
              role="region"
              aria-label="Task table"
              tabIndex={0}
            >
              <table className="work-table">
                <caption className="sr-only">
                  {visibleTasks.length} tasks in the selected filter
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Done</th>
                    <th scope="col">Task</th>
                    <th scope="col">Course</th>
                    <th scope="col">Priority</th>
                    <th scope="col">Due</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTasks.map((item) => (
                    <tr
                      key={item.id}
                      className={item.completed ? "record-complete" : ""}
                      data-selected={editing?.id === item.id}
                    >
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Complete ${item.title}`}
                          checked={item.completed}
                          disabled={busy}
                          onChange={() =>
                            void apply(async () => {
                              await toggleTask(item.id);
                              return getLocalWorkspace();
                            })
                          }
                        />
                      </td>
                      <th scope="row">
                        <button
                          className="work-task-title"
                          aria-pressed={editing?.id === item.id}
                          onClick={() => edit(item)}
                        >
                          {item.title}
                        </button>
                        <small>
                          {item.kind === "exam"
                            ? "Exam"
                            : item.kind === "assignment"
                              ? "Assignment"
                              : "Task"}{" "}
                          · {item.minutes} min
                        </small>
                      </th>
                      <td>
                        {workspace.courses.find(
                          (course) => course.id === item.courseId,
                        )?.code ||
                          workspace.courses.find(
                            (course) => course.id === item.courseId,
                          )?.title ||
                          "—"}
                      </td>
                      <td>
                        <span title={`Priority ${item.priority} of 5`}>
                          {priorityLabel(item.priority)}
                        </span>
                      </td>
                      <td>
                        {dueLabel(
                          item,
                          dayKey(
                            new Date(),
                            workspace.profile?.timezone ?? "UTC",
                          ),
                          workspace.profile?.timezone ?? "UTC",
                        )}
                      </td>
                      <td>
                        <button
                          className="text-button danger"
                          aria-label={`Delete ${item.title}`}
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(`Delete ${item.title}?`))
                              void apply(() =>
                                deleteLocalTask(item.id, item.version),
                              ).then((updated) => {
                                if (!updated) return;
                                session.workDrafts.delete(item.id);
                                session.drafts.delete(item.id);
                                if (editing?.id === item.id) resetEditor();
                              });
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              <ListChecks />
              <strong>No {filter} work</strong>
              <p>
                {workspace.tasks.length
                  ? "Choose another filter or add work with the inspector."
                  : "Add your first task or import a syllabus to create reviewable deadlines."}
              </p>
            </div>
          )}
        </section>
        {(mode !== "compact" || wide) && inspector}
      </div>
      {mode === "compact" && !wide && inspectorOpen && (
        <Modal
          title={editing ? "Edit task" : "New task"}
          subtitle="Unsaved edits stay in this unlocked session."
          close={() => {
            if (!busy) setInspectorOpen(false);
          }}
          className="work-task-drawer"
        >
          {error && <p role="alert">{error}</p>}
          {inspector}
        </Modal>
      )}
    </section>
  );
}
