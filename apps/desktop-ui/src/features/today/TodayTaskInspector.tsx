import { CalendarDays, Clock3, Flag, MapPin, X } from "lucide-react";
import type { PlanBlock, TaskRecord, WorkspaceSnapshot } from "../../native";
import { dueLabel, priorityLabel, riskLabel } from "./todayModel";
import { TaskDetailsEditor } from "../tasks/TaskDetailsEditor";

export function TodayTaskInspector({
  task,
  workspace,
  blocks,
  day,
  timezone,
  busy,
  embedded,
  onClose,
  onEdit,
  onComplete,
  onStart,
}: {
  embedded?: boolean;
  task: TaskRecord;
  workspace: WorkspaceSnapshot;
  blocks: PlanBlock[];
  day: string;
  timezone: string;
  busy: boolean;
  onClose: () => void;
  onEdit: (id: string) => void;
  onComplete: (id: string) => void;
  onStart: (id: string) => void;
}) {
  const course = workspace.courses.find((c) => c.id === task.courseId);
  const block = blocks.find((b) => b.taskId === task.id && !b.completed);
  return (
    <aside className="today-task-inspector" aria-label="Selected task">
      {!embedded && (
        <header>
          <span>Task inspector</span>
          <button aria-label="Close task inspector" onClick={onClose}>
            <X />
          </button>
        </header>
      )}
      <div className="inspector-content">
        <p className="inspector-kind">
          {task.kind === "exam" ? "Exam" : "Task"}
        </p>
        <h2>{task.title}</h2>
        {course && (
          <p className="inspector-course">{course.code || course.title}</p>
        )}
        <dl>
          <div>
            <dt>
              <CalendarDays /> Due
            </dt>
            <dd>{dueLabel(task, day, timezone)}</dd>
          </div>
          <div>
            <dt>
              <Clock3 /> Estimate
            </dt>
            <dd>{task.minutes} min</dd>
          </div>
          <div>
            <dt>
              <Flag /> Priority
            </dt>
            <dd>{priorityLabel(task.priority)}</dd>
          </div>
          <div>
            <dt>Academic risk</dt>
            <dd>{riskLabel(task.academicRisk)}</dd>
          </div>
          {task.location && (
            <div>
              <dt>
                <MapPin /> Location
              </dt>
              <dd>{task.location}</dd>
            </div>
          )}
        </dl>
        <TaskDetailsEditor
          key={task.id}
          taskId={task.id}
          completed={task.completed}
        />
        <h3>Planning</h3>
        <p>
          {task.splittable
            ? `${task.minSessionMinutes}–${task.maxSessionMinutes} minute sessions`
            : "One uninterrupted session"}{" "}
          · {task.energyDemand} energy
        </p>
        {task.dependencies.length > 0 && (
          <>
            <h3>Depends on</h3>
            <ul>
              {task.dependencies.map((id) => (
                <li key={id}>
                  {workspace.tasks.find((t) => t.id === id)?.title ??
                    "Unavailable task"}
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="inspector-actions">
          <button onClick={() => onEdit(task.id)}>Edit task</button>
          <button disabled={busy} onClick={() => onComplete(task.id)}>
            {task.completed ? "Mark incomplete" : "Mark complete"}
          </button>
          {block && (
            <button
              className="today-primary"
              disabled={busy}
              onClick={() => onStart(block.id)}
            >
              Start focus
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
