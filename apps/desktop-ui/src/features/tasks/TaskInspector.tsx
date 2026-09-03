import type { TaskInput, TaskRecord, WorkspaceSnapshot } from "../../native";
import { TaskDetailsEditor } from "./TaskDetailsEditor";
import { dateTimeValue } from "./taskEditorModel";

export function TaskInspector({
  editorRef,
  workspace,
  task,
  editing,
  busy,
  setTask,
  reset,
  save,
}: {
  editorRef?: React.Ref<HTMLElement>;
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
      ref={editorRef}
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
        <label className="field full">
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
      <p className="field-help">Date and time inputs use this computer’s timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
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
          completed={
            workspace.tasks.find((item) => item.id === editing.id)?.completed ??
            false
          }
        />
      )}
    </aside>
  );
}
