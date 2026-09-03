import { useEffect, useMemo, useState } from "react";
import { CircleAlert, HardDrive, ListChecks, Upload, X } from "lucide-react";
import {
  createLocalTask,
  deleteLocalTask,
  getDashboard,
  getLocalWorkspace,
  updateLocalTask,
} from "../native";
import type { TaskInput, TaskRecord, WorkspaceSnapshot } from "../native";
import type { WorkspaceRouteProps } from "./workspaceTypes";
import { TaskDetailsEditor } from "../features/tasks/TaskDetailsEditor";

type WorkFilter = "inbox" | "upcoming" | "overdue" | "exams" | "completed";

const emptyTask = (): TaskInput => ({
  title: "",
  kind: "assignment",
  minutes: 30,
  priority: 3,
  academicRisk: 0,
  energyDemand: "medium",
  location: "",
  splittable: true,
  minSessionMinutes: 20,
  maxSessionMinutes: 60,
  dependencies: [],
});
const dateTimeValue = (value?: string) =>
  value ? new Date(value).toISOString().slice(0, 16) : "";
const formatDateTime = (value?: string) =>
  value
    ? new Intl.DateTimeFormat([], {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "Not set";

export function WorkView({
  initialTaskId,
  initialFilter,
  onDashboard,
  onImport,
  onStudy,
}: WorkspaceRouteProps & { initialTaskId?: string | null; initialFilter?: "all" | "high" | "completed" }) {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [filter, setFilter] = useState<WorkFilter | "all" | "high">(initialFilter ?? "upcoming");
  const [task, setTask] = useState<TaskInput>(emptyTask);
  const [editing, setEditing] = useState<TaskRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void getLocalWorkspace()
      .then((value) => {
        if (active) {
          setWorkspace(value);
          const selected = value.tasks.find(t => t.id === initialTaskId);
          if (selected) edit(selected);
        }
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [initialTaskId]);

  useEffect(() => { if (initialFilter) setFilter(initialFilter); }, [initialFilter]);

  const apply = async (operation: () => Promise<WorkspaceSnapshot>) => {
    setBusy(true);
    setError("");
    try {
      setWorkspace(await operation());
      onDashboard(await getDashboard());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const visibleTasks = useMemo(
    () =>
      workspace?.tasks.filter((item) => {
        const overdue =
          Boolean(item.dueAt) &&
          new Date(item.dueAt!).getTime() < Date.now() &&
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
    setEditing(value);
    setTask({
      title: value.title,
      minutes: value.minutes,
      dueAt: value.dueAt,
      courseId: value.courseId,
      priority: value.priority,
      kind: value.kind,
      academicRisk: value.academicRisk,
      earliestStart: value.earliestStart,
      energyDemand: value.energyDemand,
      location: value.location,
      splittable: value.splittable,
      minSessionMinutes: value.minSessionMinutes,
      maxSessionMinutes: value.maxSessionMinutes,
      dependencies: value.dependencies,
      expectedVersion: value.version,
    });
  };

  const resetEditor = () => {
    setEditing(null);
    setTask(emptyTask());
  };

  if (!workspace)
    return (
      <div className="content workspace-page">
        <div className="loading">
          <strong>Loading your encrypted local records…</strong>
          {error && <p>{error}</p>}
        </div>
      </div>
    );

  return (
    <section
      className="content workspace-page mode-assignments"
      data-route="work"
      aria-label="Work workspace"
    >
      <div className="page-head">
        <div>
          <p className="eyebrow">Decide what comes next</p>
          <h1>Work</h1>
          <p>Inbox, upcoming work, overdue items, exams, and completed work.</p>
        </div>
        <div className="page-head-actions">
          <button className="outline" onClick={onImport}>
            <Upload />
            Import
          </button>
          <button className="outline" onClick={onStudy}>
            Open Study
          </button>
          <span className="mode-pill">
            <HardDrive />
            Local authority
          </span>
        </div>
      </div>
      {error && (
        <div className="alert" role="alert">
          <CircleAlert />
          <span>{error}</span>
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
              ["all", "high", "inbox", "upcoming", "overdue", "exams", "completed"] as const
            ).map((value) => (
              <button
                role="tab"
                aria-selected={filter === value}
                className={filter === value ? "active" : ""}
                key={value}
                onClick={() => setFilter(value)}
              >
                {value[0].toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
          {visibleTasks.length ? (
            <div className="record-list compact">
              {visibleTasks.map((item) => (
                <article
                  className={item.completed ? "record-complete" : ""}
                  key={item.id}
                >
                  <div className={`record-icon task ${item.kind}`}>
                    <ListChecks />
                  </div>
                  <div>
                    <strong>{item.title}</strong>
                    <small>
                      {item.kind === "exam"
                        ? "Exam"
                        : item.kind === "assignment"
                          ? "Assignment"
                          : "Task"}{" "}
                      · {item.minutes} min · Priority {item.priority}
                      {item.dueAt
                        ? ` · Due ${formatDateTime(item.dueAt)}`
                        : " · No deadline"}
                    </small>
                    <small>
                      {item.energyDemand} energy ·{" "}
                      {item.splittable
                        ? `${item.minSessionMinutes}–${item.maxSessionMinutes} min sessions`
                        : "Indivisible"}
                    </small>
                  </div>
                  <div className="record-actions">
                    <button className="outline" onClick={() => edit(item)}>
                      Edit
                    </button>
                    <button
                      className="text-button danger"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Delete ${item.title}?`))
                          void apply(() =>
                            deleteLocalTask(item.id, item.version),
                          );
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
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
        <TaskInspector
          workspace={workspace}
          task={task}
          editing={editing}
          busy={busy}
          setTask={setTask}
          reset={resetEditor}
          save={() =>
            void apply(() =>
              editing
                ? updateLocalTask(editing.id, task)
                : createLocalTask(task),
            ).then(resetEditor)
          }
        />
      </div>
    </section>
  );
}

function TaskInspector({
  workspace,
  task,
  editing,
  busy,
  setTask,
  reset,
  save,
}: {
  workspace: WorkspaceSnapshot;
  task: TaskInput;
  editing: TaskRecord | null;
  busy: boolean;
  setTask: React.Dispatch<React.SetStateAction<TaskInput>>;
  reset: () => void;
  save: () => void;
}) {
  return (
    <aside
      className="workspace-panel task-editor work-inspector"
      aria-label="Selected task inspector"
    >
      <h2>{editing ? `Edit ${task.kind}` : "Add an assignment or exam"}</h2>
      <div className="form-grid compact">
        <label className="field full">
          Task
          <input
            value={task.title}
            onChange={(event) =>
              setTask((current) => ({ ...current, title: event.target.value }))
            }
            placeholder="Draft lab report"
          />
        </label>
        <label className="field">
          Type
          <select
            value={task.kind}
            onChange={(event) =>
              setTask((current) => ({
                ...current,
                kind: event.target.value as TaskInput["kind"],
              }))
            }
          >
            <option value="assignment">Assignment</option>
            <option value="exam">Exam</option>
            <option value="task">General task</option>
          </select>
        </label>
        <label className="field">
          Course
          <select
            value={task.courseId ?? ""}
            onChange={(event) =>
              setTask((current) => ({
                ...current,
                courseId: event.target.value || undefined,
              }))
            }
          >
            <option value="">No course</option>
            {workspace.courses.map((item) => (
              <option key={item.id} value={item.id}>
                {item.code || item.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Estimate
          <input
            type="number"
            min="5"
            max="1440"
            step="5"
            value={task.minutes}
            onChange={(event) =>
              setTask((current) => ({
                ...current,
                minutes: Number(event.target.value),
              }))
            }
          />
        </label>
        <label className="field">
          Due date
          <input
            type="datetime-local"
            value={dateTimeValue(task.dueAt)}
            onChange={(event) =>
              setTask((current) => ({
                ...current,
                dueAt: event.target.value
                  ? new Date(event.target.value).toISOString()
                  : undefined,
              }))
            }
          />
        </label>
      </div>
      <details className="scheduling-options">
        <summary>Scheduling options</summary>
        <p className="field-help">
          Coqui chooses the do date from these constraints. The due date above
          never changes.
        </p>
        <div className="form-grid">
          <label className="field">
            Earliest start
            <input
              type="datetime-local"
              value={dateTimeValue(task.earliestStart)}
              onChange={(event) =>
                setTask((current) => ({
                  ...current,
                  earliestStart: event.target.value
                    ? new Date(event.target.value).toISOString()
                    : undefined,
                }))
              }
            />
          </label>
          <label className="field">
            Priority
            <input
              type="number"
              min="1"
              max="5"
              value={task.priority}
              onChange={(event) =>
                setTask((current) => ({
                  ...current,
                  priority: Number(event.target.value),
                }))
              }
            />
          </label>
          <label className="field">
            Academic risk
            <input
              type="number"
              min="0"
              max="5"
              value={task.academicRisk}
              onChange={(event) =>
                setTask((current) => ({
                  ...current,
                  academicRisk: Number(event.target.value),
                }))
              }
            />
          </label>
          <label className="field">
            Energy
            <select
              value={task.energyDemand}
              onChange={(event) =>
                setTask((current) => ({
                  ...current,
                  energyDemand: event.target.value as TaskInput["energyDemand"],
                }))
              }
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <label className="field">
            Location
            <input
              value={task.location}
              onChange={(event) =>
                setTask((current) => ({
                  ...current,
                  location: event.target.value,
                }))
              }
            />
          </label>
          <label className="field">
            Minimum session
            <input
              type="number"
              min="5"
              max="240"
              step="5"
              disabled={!task.splittable}
              value={task.minSessionMinutes}
              onChange={(event) =>
                setTask((current) => ({
                  ...current,
                  minSessionMinutes: Number(event.target.value),
                }))
              }
            />
          </label>
          <label className="field">
            Maximum session
            <input
              type="number"
              min="5"
              max="240"
              step="5"
              disabled={!task.splittable}
              value={task.maxSessionMinutes}
              onChange={(event) =>
                setTask((current) => ({
                  ...current,
                  maxSessionMinutes: Number(event.target.value),
                }))
              }
            />
          </label>
        </div>
        <label className="setting-toggle compact">
          <input
            type="checkbox"
            checked={task.splittable}
            onChange={(event) =>
              setTask((current) => ({
                ...current,
                splittable: event.target.checked,
              }))
            }
          />
          <span>
            <strong>Allow this task to split into sessions</strong>
            <small>
              Coqui still respects the minimum and maximum session lengths.
            </small>
          </span>
        </label>
        <fieldset className="dependency-picker">
          <legend>Prerequisites</legend>
          {workspace.tasks.filter((item) => item.id !== editing?.id).length ? (
            workspace.tasks
              .filter((item) => item.id !== editing?.id)
              .map((item) => (
                <label key={item.id}>
                  <input
                    type="checkbox"
                    checked={task.dependencies.includes(item.id)}
                    onChange={(event) =>
                      setTask((current) => ({
                        ...current,
                        dependencies: event.target.checked
                          ? [...current.dependencies, item.id]
                          : current.dependencies.filter(
                              (dependency) => dependency !== item.id,
                            ),
                      }))
                    }
                  />
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      {item.completed ? "Completed" : "Must finish first"}
                    </small>
                  </span>
                </label>
              ))
          ) : (
            <p>Add another task to define a prerequisite.</p>
          )}
        </fieldset>
      </details>
      <div className="modal-actions">
        {editing && (
          <button className="outline" onClick={reset}>
            Cancel
          </button>
        )}
        <button
          className="solid"
          disabled={busy || !task.title.trim()}
          onClick={save}
        >
          {editing ? "Save task" : "Add task and replan"}
        </button>
      </div>
      {editing && workspace.tasks.some((item) => item.id === editing.id) && (
        <TaskDetailsEditor
          key={editing.id}
          taskId={editing.id}
          completed={workspace.tasks.find((item) => item.id === editing.id)?.completed ?? false}
        />
      )}
    </aside>
  );
}
