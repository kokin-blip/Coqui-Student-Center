import { useEffect, useState } from "react";
import { getTaskPlan, type TaskPlan } from "../../native";
import { CalendarDays, Clock3, Flag, MapPin, X } from "lucide-react";
import type { PlanBlock, TaskRecord, WorkspaceSnapshot } from "../../native";
import { dueLabel, priorityLabel, riskLabel } from "./todayModel";
import { TaskDetailsEditor } from "../tasks/TaskDetailsEditor";
import { priorityReasonLabel, taskKindName } from "../tasks/taskPresentation";

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
  const [planning, setPlanning] = useState<{ taskId: string; value: TaskPlan } | null>(null);
  const [planningError, setPlanningError] = useState("");
  useEffect(() => {
    let active = true;
    setPlanningError("");
    void getTaskPlan(task.id).then(value => { if (active) setPlanning({ taskId:task.id, value }); }).catch(reason => { if (active) setPlanningError(String(reason)); });
    return () => { active = false; };
  }, [task.id, task.version, blocks]);
  const plan = planning?.taskId === task.id ? planning.value : null;
  const block = plan?.sessions.find(b => !b.completed) ?? blocks.find((b) => b.taskId === task.id && !b.completed);
  const format = (value: string) => new Intl.DateTimeFormat([], { timeZone:timezone, dateStyle:"medium", timeStyle:"short" }).format(new Date(value));
  const time = (value: string) => new Intl.DateTimeFormat([], { timeZone:timezone, hour:"numeric", minute:"2-digit" }).format(new Date(value));
  const explanation = (codes: string[]) => [
    codes.includes("mixed") ? "Starts early and spreads remaining sessions across available days." : codes.includes("balanced") ? "Balances work across available days." : codes.includes("earliest") ? "Uses the earliest available opening." : "Fits your available study time.",
    "Classes, travel, breaks, sleep, and protected time are reserved.",
    ...(codes.includes("overdue_recovery") ? ["Recovery time for overdue work; the original deadline remains above."] : []),
    ...(codes.includes("plan_stability") ? ["Keeps an existing suitable time."] : []),
  ].join(" ");
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
        <p className="inspector-kind">{taskKindName(task.kind)}</p>
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
        <section aria-label="Recommended timeframe">
          <h3>Recommended timeframe</h3>
          {task.completed ? <p>This assignment is complete.</p> : planningError ? <p role="alert">Recommended times could not be loaded: {planningError}</p> : !plan ? <p role="status">Loading recommended times…</p> : <>
            {plan.sessions.length > 0 ? <ul className="recommended-sessions">{plan.sessions.map(session => <li key={session.id}>
              <strong>{format(session.startsAt)} – {time(session.endsAt)}</strong>
              <p>{Math.round((Date.parse(session.endsAt) - Date.parse(session.startsAt)) / 60000)} min · {session.startedAt ? "Started" : session.locked ? "Locked" : "Recommended"}</p>
              <p className="field-help">{explanation(session.reasonCodes)}</p>
            </li>)}</ul> : <p>No recommended session is available in the next 14 days.</p>}
            {plan.unscheduledMinutes > 0 && <p role="status">{plan.sessions.length ? "Partially scheduled: " : "Unscheduled: "}{plan.unscheduledMinutes} min remain. {plan.reasonCodes.includes("blocked_dependency") ? "Finish or resolve prerequisite work first." : plan.reasonCodes.includes("session_limits_infeasible") ? "Adjust the effort estimate or session length in task details." : "There is not enough available time. Adjust your availability, effort estimate, or deadline."}</p>}
            <p className="field-help">All times in {timezone}. Recommendations use local scheduling, without AI.</p>
          </>}
        </section>
        {task.priorityReasonCodes.length > 0 && (
          <div className="priority-explanation">
            <h3>Why this priority</h3>
            <p>{task.priorityReasonCodes.map(priorityReasonLabel).join(" · ")}</p>
          </div>
        )}
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
