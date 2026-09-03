import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronRight,
  CircleAlert,
  HelpCircle,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { getCalendarAgenda } from "../native";
import type {
  Dashboard,
  OcrStatus,
  PlanBlock,
  WorkspaceSnapshot,
} from "../native";
import type { InterfaceMode } from "../features/shell/interfacePreferences";
import { TodaySchedule } from "../features/today/TodaySchedule";
import { TodayTaskInspector } from "../features/today/TodayTaskInspector";
import {
  blocksForDay,
  capacityForDay,
  dateLabel,
  dayKey,
  dueLabel,
  mondayOf,
  priorityLabel,
  riskLabel,
  shiftDay,
} from "../features/today/todayModel";
import "../features/today/today.css";
import { Modal } from "./Modal";

type Props = {
  data: Dashboard;
  workspace: WorkspaceSnapshot | null;
  ocr: OcrStatus;
  desktop: boolean;
  busy: boolean;
  error: string;
  checklistDismissed: boolean;
  pendingCount: number;
  mode?: InterfaceMode;
  selectedTaskId?: string | null;
  onSelectTask?: (id: string | null) => void;
  onEditTask?: (id: string) => void;
  onCalendar?: () => void;
  onWork?: () => void;
  onClearError: () => void;
  onOpenCourses: () => void;
  onAddTask: () => void;
  onImport: () => void;
  onDismissChecklist: () => void;
  onStartBlock: (id: string) => void;
  onReplan: () => void;
  onToggleTask: (id: string) => void;
  onAssistant: () => void;
  onConflicts: () => void;
  onReview: () => void;
  onCanvas: () => void;
};

export function TodayView(p: Props) {
  const compact = p.mode === "compact";
  const [date, setDate] = useState(
    () => p.data.planDate.slice(0, 10) || dayKey(new Date(), p.data.timezone),
  );
  const referenceClock =
    import.meta.env.DEV &&
    !p.desktop &&
    ["comfy", "compact"].includes(
      new URLSearchParams(location.search).get("reference") ?? "",
    );
  const [now, setNow] = useState(() =>
    referenceClock
      ? new Date(
          `${p.data.planDate.slice(0, 10)}T${compact ? "09:41" : "14:30"}:00-04:00`,
        )
      : new Date(),
  );
  const [agenda, setAgenda] = useState<PlanBlock[]>(p.data.blocks);
  const [loading, setLoading] = useState(false);
  const [agendaError, setAgendaError] = useState("");
  const [reload, setReload] = useState(0);
  const [wide, setWide] = useState(() => window.innerWidth >= 1440);
  useEffect(() => {
    const resize = () => setWide(window.innerWidth >= 1440);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  const selection =
    p.selectedTaskId === undefined ? localSelection : p.selectedTaskId;
  const select = (id: string | null) => {
    setLocalSelection(id);
    p.onSelectTask?.(id);
  };
  const weekStart = mondayOf(date);
  const days = compact
    ? Array.from({ length: 7 }, (_, i) => shiftDay(weekStart, i))
    : [date];
  const today = dayKey(now, p.data.timezone);
  useEffect(() => {
    if (referenceClock) return;
    const tick = window.setInterval(() => setNow(new Date()), 60000);
    return () => window.clearInterval(tick);
  }, [referenceClock]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setAgendaError("");
    getCalendarAgenda(compact ? weekStart : date)
      .then((value) => {
        if (active) setAgenda(value.blocks);
      })
      .catch(() => {
        if (active)
          setAgendaError(
            "This schedule could not be loaded. Try again or open Calendar.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [date, weekStart, compact, p.data, reload]);
  const blocks = useMemo(() => {
    const values = new Map(agenda.map((b) => [b.id, b]));
    p.data.blocks.forEach((b) => values.set(b.id, b));
    return [...values.values()];
  }, [agenda, p.data.blocks]);
  const tasks = p.workspace?.tasks ?? [];
  const selected = tasks.find((t) => t.id === selection);
  const started = p.data.blocks.filter((b) => b.startedAt);
  const averageStartVariance = started.length
    ? Math.round(
        started.reduce(
          (sum, b) =>
            sum + (Date.parse(b.startedAt!) - Date.parse(b.startsAt)) / 60000,
          0,
        ) / started.length,
      )
    : null;
  const openTasks = tasks.filter((t) => !t.completed);
  const deadlines = [...openTasks]
    .filter((t) => t.dueAt)
    .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!));
  const dayBlocks = blocksForDay(blocks, date, p.data.timezone);
  const capacity = capacityForDay(
    p.workspace,
    blocks,
    date,
    p.data.timezone,
    now,
  );
  const term = p.workspace?.terms.find(
    (t) => t.active && date >= t.startsOn && date <= t.endsOn,
  );
  const weekNumber = term
    ? Math.floor((Date.parse(date) - Date.parse(term.startsOn)) / 604800000) + 1
    : 0;
  const weekCount = term
    ? Math.ceil(
        (Date.parse(term.endsOn) - Date.parse(term.startsOn) + 86400000) /
          604800000,
      )
    : 0;
  const showSetup =
    !p.checklistDismissed &&
    p.workspace &&
    (!p.workspace.courses.length ||
      !p.workspace.classMeetings.length ||
      !tasks.length);
  const schedule = (
    <TodaySchedule
      days={days}
      blocks={blocks}
      tasks={tasks}
      timezone={p.data.timezone}
      now={now}
      compact={compact}
      selectedTaskId={selection}
      onSelect={select}
      onComplete={p.onToggleTask}
      busy={p.busy}
      onPrevious={() => setDate(shiftDay(date, compact ? -7 : -1))}
      onNext={() => setDate(shiftDay(date, compact ? 7 : 1))}
      onToday={() => setDate(today)}
      onAdd={p.onCalendar ?? p.onAddTask}
    />
  );
  const drawer = !compact || !wide;
  const inspector =
    selected && p.workspace ? (
      <TodayTaskInspector
        embedded={drawer}
        task={selected}
        workspace={p.workspace}
        blocks={blocks}
        day={today}
        timezone={p.data.timezone}
        busy={p.busy}
        onClose={() => select(null)}
        onEdit={p.onEditTask ?? (() => p.onWork?.())}
        onComplete={p.onToggleTask}
        onStart={p.onStartBlock}
      />
    ) : null;

  return (
    <section
      className={`today-workspace ${compact ? "today-compact" : "today-comfy"}`}
      aria-label="Today workspace"
      aria-busy={loading}
    >
      {!compact && (
        <header className="today-heading">
          <h1>Today</h1>
          <div>
            <CalendarDays />
            <span>
              {dateLabel(date, {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </span>
            {term && (
              <span className="term-week">
                Week {weekNumber} of {weekCount}
              </span>
            )}
          </div>
        </header>
      )}
      {(p.error || agendaError) && (
        <div className="today-notice" role="alert">
          <CircleAlert />
          <span>{p.error || agendaError}</span>
          {agendaError && (
            <button onClick={() => setReload((n) => n + 1)}>
              Retry schedule
            </button>
          )}
          <button
            onClick={() => {
              p.onClearError();
              setAgendaError("");
            }}
            aria-label="Dismiss error"
          >
            <X />
          </button>
        </div>
      )}
      {showSetup && (
        <div
          className="today-setup"
          role="region"
          aria-label="Finish setting up"
        >
          <span>Make this day yours.</span>
          <button onClick={p.onOpenCourses}>Add classes</button>
          <button onClick={p.onImport}>Import schedule</button>
          <button
            onClick={p.onDismissChecklist}
            aria-label="Dismiss setup checklist"
          >
            <X />
          </button>
        </div>
      )}
      {(p.pendingCount > 0 || p.data.conflicts.length > 0) && (
        <div className="today-review-notice">
          {p.data.conflicts.length > 0 && (
            <button onClick={p.onConflicts}>
              <CircleAlert /> {p.data.conflicts.length} decision
              {p.data.conflicts.length === 1 ? "" : "s"} needed <ChevronRight />
            </button>
          )}
          {p.pendingCount > 0 && (
            <button aria-label="Review candidates" onClick={p.onReview}>
              {p.pendingCount} imported items to review <ChevronRight />
            </button>
          )}
        </div>
      )}
      {compact ? (
        <div
          className={`compact-layout ${inspector && !drawer ? "with-inspector" : ""}`}
        >
          <div className="compact-main">
            {schedule}
            <div className="compact-lower">
              <section className="work-queue" aria-label="Work queue">
                <header>
                  <h2>
                    Work queue <span>{openTasks.length}</span>
                  </h2>
                  <button aria-label="Add task" onClick={p.onAddTask}>
                    <Plus />
                  </button>
                </header>
                <div className="task-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">
                          <span className="sr-only">Completion</span>
                        </th>
                        <th scope="col">Task</th>
                        <th scope="col">Course</th>
                        <th scope="col">Priority</th>
                        <th scope="col">Due</th>
                      </tr>
                    </thead>
                    <tbody>
                      {openTasks.map((task) => (
                        <tr
                          className={selection === task.id ? "selected" : ""}
                          key={task.id}
                        >
                          <td>
                            <input
                              type="checkbox"
                              checked={task.completed}
                              disabled={p.busy}
                              aria-label={`Complete ${task.title}`}
                              onChange={() => p.onToggleTask(task.id)}
                            />
                          </td>
                          <td>
                            <button onClick={() => select(task.id)}>
                              {task.title}
                            </button>
                          </td>
                          <td>
                            {p.workspace?.courses.find(
                              (c) => c.id === task.courseId,
                            )?.code || "—"}
                          </td>
                          <td>{priorityLabel(task.priority)}</td>
                          <td>{dueLabel(task, today, p.data.timezone)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {openTasks.length === 0 && (
                  <div className="today-empty">
                    <strong>Your work queue is clear.</strong>
                    <button onClick={p.onAddTask}>Add a task</button>
                  </div>
                )}
              </section>
              <section className="task-groups" aria-label="Tasks by risk">
                <h2>
                  Risk{" "}
                  <HelpCircle aria-label="Academic risk: High 4–5, Medium 2–3, Low 0–1" />
                </h2>
                {["High", "Medium", "Low"].map((risk) => (
                  <div key={risk}>
                    <h3 className={`risk-${risk.toLowerCase()}`}>
                      {risk} risk{" "}
                      <span>
                        {
                          openTasks.filter(
                            (t) => riskLabel(t.academicRisk) === risk,
                          ).length
                        }
                      </span>
                    </h3>
                    {openTasks
                      .filter((t) => riskLabel(t.academicRisk) === risk)
                      .slice(0, 4)
                      .map((t) => (
                        <button key={t.id} onClick={() => select(t.id)}>
                          {t.title}
                          <small>{dueLabel(t, today, p.data.timezone)}</small>
                        </button>
                      ))}
                  </div>
                ))}
              </section>
              <section
                className="task-groups due-groups"
                aria-label="Tasks by deadline"
              >
                <h2>Due</h2>
                {["Overdue", "Today", "Tomorrow", "Later"].map((group) => (
                  <div key={group}>
                    <h3>{group}</h3>
                    {deadlines
                      .filter((t) => {
                        const label = dueLabel(t, today, p.data.timezone);
                        return group === "Later"
                          ? !["Overdue", "Today", "Tomorrow"].includes(label)
                          : label === group;
                      })
                      .slice(0, 4)
                      .map((t) => (
                        <button key={t.id} onClick={() => select(t.id)}>
                          {t.title}
                          <small>
                            {p.workspace?.courses.find(
                              (c) => c.id === t.courseId,
                            )?.code || "Task"}
                          </small>
                        </button>
                      ))}
                  </div>
                ))}
              </section>
            </div>
          </div>
          {!drawer && inspector}
        </div>
      ) : (
        <div className="comfy-layout">
          <div>
            {schedule}
            {dayBlocks.length === 0 && (
              <div className="today-empty">
                <strong>Your day is open.</strong>
                <p>Add work or import your schedule to build a plan.</p>
                <button onClick={p.onAddTask}>Add something</button>
              </div>
            )}
          </div>
          <aside className="today-support" aria-label="Today details">
            <section className="today-panel next-step">
              <header>
                <Sparkles />
                <h2>Your next step</h2>
              </header>
              <div className="next-step-body">
                <h3>{p.data.nextAction?.title ?? "Your plan is clear"}</h3>
                <p>
                  {p.data.nextAction?.explanation ??
                    "Add a task and Coqui will find a place for it."}
                </p>
                <div className="focus-actions">
                  <button
                    className="today-primary"
                    disabled={!p.data.nextAction || p.busy}
                    onClick={() =>
                      p.data.nextAction &&
                      p.onStartBlock(p.data.nextAction.blockId)
                    }
                  >
                    <Play /> Start focus
                  </button>
                  <span>{p.data.nextAction?.durationMinutes ?? 0} min</span>
                </div>
              </div>
            </section>
            <section className="today-panel upcoming-deadlines">
              <header>
                <h2>Upcoming deadlines</h2>
                <button onClick={p.onWork}>View all</button>
              </header>
              {deadlines.slice(0, 3).map((t) => (
                <button
                  key={t.id}
                  className="deadline-row"
                  onClick={() => select(t.id)}
                >
                  <span className="deadline-date">
                    <small>
                      {dateLabel(dayKey(t.dueAt!, p.data.timezone), {
                        month: "short",
                      })}
                    </small>
                    <strong>
                      {dateLabel(dayKey(t.dueAt!, p.data.timezone), {
                        day: "numeric",
                      })}
                    </strong>
                  </span>
                  <span className="deadline-title">
                    {t.title}
                    <small>
                      {p.workspace?.courses.find((c) => c.id === t.courseId)
                        ?.code || "Task"}
                    </small>
                  </span>
                  <span className="deadline-distance">
                    {dueLabel(t, today, p.data.timezone)}
                  </span>
                </button>
              ))}
              {deadlines.length === 0 && (
                <p className="panel-empty">
                  No upcoming deadlines. Add one when you're ready.
                </p>
              )}
              <button className="deadline-add" onClick={p.onAddTask}>
                <Plus /> Add deadline
              </button>
            </section>
            <section
              className="today-panel capacity-panel"
              aria-label="Today's capacity"
            >
              <header>
                <h2>
                  Capacity <HelpCircle />
                </h2>
                <strong>{capacity?.label ?? "Not set"}</strong>
              </header>
              <div className="capacity-body">
                <p>
                  {capacity
                    ? `${Math.floor(capacity.free / 60)}h ${capacity.free % 60}m remaining free time`
                    : "Set availability to see how much room your day has."}
                </p>
                <meter
                  aria-label="Remaining available time"
                  min={0}
                  max={capacity?.available || 1}
                  value={capacity?.free ?? 0}
                />
                <p className="capacity-meta">
                  {dayBlocks.filter((b) => b.kind === "study").length} tasks ·{" "}
                  {dayBlocks.filter((b) => b.kind === "class").length} classes ·{" "}
                  {p.data.conflicts.length
                    ? `${p.data.conflicts.length} conflicts`
                    : "No conflicts"}
                </p>
                <details>
                  <summary>How this is estimated</summary>
                  <p>
                    Remaining wall-clock availability minus scheduled work,
                    fixed commitments, sleep, and travel. Overlaps count once.
                    This is a planning estimate.
                  </p>
                </details>
              </div>
            </section>
          </aside>
        </div>
      )}
      <footer className="today-secondary-actions">
        <button onClick={p.onReplan}>
          <RefreshCw /> Replan my day
        </button>
        <button onClick={p.onAssistant}>Capture a thought</button>
        <button onClick={p.onImport}>Import work</button>
        <button onClick={p.onCanvas}>Canvas connections</button>
        {p.data.nextAction && (
          <details>
            <summary>Why this task?</summary>
            <p>
              {p.data.nextAction.reasonCodes
                .map((c) => c.replaceAll("_", " "))
                .join(" · ")}
            </p>
            {p.data.nextAction.alternatives.map((a) => (
              <p key={a.blockId}>
                {a.title} · {a.durationMinutes} min
              </p>
            ))}
          </details>
        )}
        <details>
          <summary>Workspace status</summary>
          <p>
            {p.desktop
              ? "Encrypted on this device."
              : "Synthetic browser preview."}{" "}
            {p.ocr.message}
          </p>
          <p>
            {p.data.blocks.filter((b) => b.completed).length} completed ·{" "}
            {started.length} focus blocks started.
          </p>
          <h3>Planned vs actual</h3>
          {averageStartVariance !== null ? (
            <p>
              Average start: {Math.abs(averageStartVariance)} min{" "}
              {averageStartVariance < 0 ? "early" : "late"}.
            </p>
          ) : (
            <p>
              Start a focus block to build a private reflection. Coqui records
              timing locally.
            </p>
          )}
        </details>
      </footer>
      {drawer && inspector && (
        <Modal
          title="Task inspector"
          subtitle="Review this task and its planning settings."
          close={() => select(null)}
          className="task-drawer"
        >
          {inspector}
        </Modal>
      )}
    </section>
  );
}
