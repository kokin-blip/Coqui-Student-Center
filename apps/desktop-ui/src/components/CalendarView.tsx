import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Plus,
  Upload,
  X,
} from "lucide-react";
import {
  deleteAcademicEvent,
  deleteCommitment,
  getCalendarAgenda,
  getDashboard,
  getLocalWorkspace,
  movePlanBlock,
  setPlanBlockLock,
  undoCalendarChange,
  toggleTask,
  startPlanBlock,
} from "../native";
import type {
  AcademicCalendarEventInput,
  AcademicCalendarEventRecord,
  CalendarAgenda,
  CommitmentEditorInput,
  CommitmentRecord,
  WorkspaceSnapshot,
} from "../native";
import type { WorkspaceRouteProps } from "./workspaceTypes";
import { useTaskDetailsSession } from "../features/tasks/TaskDetailsSession";
import { TodayTaskInspector } from "../features/today/TodayTaskInspector";
import {
  CalendarInspector,
  emptyCommitment,
  emptyAcademicEvent,
} from "../features/calendar/CalendarInspector";
import {
  dayKey as dateKey,
  shiftDay,
  mondayOf,
  dateLabel,
  positionBlocks,
  clockLabel,
} from "../features/today/todayModel";
import { Modal } from "./Modal";
import "../features/calendar/calendar.css";
import { localToIso } from "../features/calendar/calendarDate";

const formatTime = (iso: string, timeZone?: string) =>
  new Intl.DateTimeFormat([], {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
const formatDateTime = (iso: string, timeZone?: string) =>
  new Intl.DateTimeFormat([], {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(iso));
const minutesBetween = (from: string, to: string) =>
  Math.max(
    0,
    Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000),
  );
const minuteOfDay = (value: string, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const number = (type: "hour" | "minute") =>
    Number(parts.find((item) => item.type === type)?.value ?? 0);
  return number("hour") * 60 + number("minute");
};
export function CalendarView({
  selectedTaskId,
  onSelectTask,
  onEditTask,
  onDashboard,
  onImport,
  onConnections,
  canvasConnections = [],
}: WorkspaceRouteProps & {
  selectedTaskId?: string | null;
  onSelectTask?: (id: string | null) => void;
  onEditTask?: (id: string) => void;
}) {
  const session = useTaskDetailsSession();
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [agenda, setAgenda] = useState<CalendarAgenda | null>(null);
  const [range, setRange] = useState<"day" | "week">(session.calendarRange);
  const [selectedDay, setSelectedDay] = useState(session.calendarDay);
  const [weekStart, setWeekStart] = useState(
    session.calendarDay ? mondayOf(session.calendarDay) : "",
  );
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(Boolean(selectedTaskId));
  const [wide, setWide] = useState(window.innerWidth >= 1440);
  const [reload, setReload] = useState(0);
  const selectedTask = workspace?.tasks.find(
    (task) => task.id === selectedTaskId,
  );
  const selectTask = (id: string) => {
    onSelectTask?.(id);
    setInspectorOpen(true);
  };
  useEffect(() => {
    const resize = () => setWide(window.innerWidth >= 1440);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    session.calendarRange = range;
    session.calendarDay = selectedDay;
  }, [range, selectedDay, session]);
  const [commitment, setCommitment] = useState<CommitmentEditorInput>(
    () => session.calendarEditor?.commitment ?? emptyCommitment(),
  );
  const [commitmentEdit, setCommitmentEdit] = useState<CommitmentRecord | null>(
    session.calendarEditor?.commitmentEdit ?? null,
  );
  const [academicEvent, setAcademicEvent] =
    useState<AcademicCalendarEventInput>(
      () => session.calendarEditor?.academicEvent ?? emptyAcademicEvent(),
    );
  const [academicEventEdit, setAcademicEventEdit] =
    useState<AcademicCalendarEventRecord | null>(
      session.calendarEditor?.academicEventEdit ?? null,
    );
  useEffect(() => {
    session.calendarEditor = {
      commitment,
      commitmentEdit,
      academicEvent,
      academicEventEdit,
    };
  }, [session, commitment, commitmentEdit, academicEvent, academicEventEdit]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setError("");
    void Promise.all([
      getLocalWorkspace(),
      getCalendarAgenda(weekStart || undefined),
    ])
      .then(([nextWorkspace, nextAgenda]) => {
        if (active) {
          setWorkspace(nextWorkspace);
          setAgenda(nextAgenda);
        }
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [weekStart, reload]);

  const refresh = async (nextWorkspace?: WorkspaceSnapshot) => {
    if (nextWorkspace) setWorkspace(nextWorkspace);
    setAgenda(await getCalendarAgenda(weekStart || undefined));
    onDashboard(await getDashboard());
  };
  const act = async (operation: () => Promise<WorkspaceSnapshot>) => {
    setBusy(true);
    setError("");
    try {
      const updated = await operation();
      setWorkspace(updated);
      try {
        await refresh(updated);
      } catch {
        setError(
          "Saved, but the calendar could not refresh. Use Refresh to reload it.",
        );
      }
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const agendaAct = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const days = useMemo(() => {
    if (!agenda) return [];
    const start = dateKey(agenda.startsAt, agenda.timezone);
    return Array.from({ length: 7 }, (_, index) => {
      const key = shiftDay(start, index);
      return {
        key,
        label: dateLabel(key, {
          weekday: "short",
          month: "short",
          day: "numeric",
        }),
        blocks: positionBlocks(agenda.blocks, key, agenda.timezone).map(
          (item) => item.block,
        ),
      };
    });
  }, [agenda]);
  useEffect(() => {
    if (
      weekStart &&
      agenda &&
      dateKey(agenda.startsAt, agenda.timezone) !== weekStart
    )
      return;
    if (!days.length || days.some((day) => day.key === selectedDay)) return;
    const today = dateKey(new Date(), agenda?.timezone ?? "UTC");
    setSelectedDay(days.find((day) => day.key === today)?.key ?? days[0].key);
  }, [agenda, days, selectedDay, weekStart]);
  const visibleDays =
    range === "week" ? days : days.filter((day) => day.key === selectedDay);
  const unscheduled =
    workspace?.tasks.filter(
      (task) =>
        !task.completed &&
        !agenda?.blocks.some((block) => block.taskId === task.id),
    ) ?? [];

  const moveBlock = (blockId: string, startsAt: string, endsAt: string) =>
    void agendaAct(() => movePlanBlock(blockId, startsAt, endsAt));
  const nudgeBlock = (
    block: CalendarAgenda["blocks"][number],
    delta: number,
    resize: boolean,
  ) => {
    const start = new Date(block.startsAt).getTime();
    const end = new Date(block.endsAt).getTime();
    moveBlock(
      block.id,
      new Date(resize ? start : start + delta * 60_000).toISOString(),
      new Date(end + delta * 60_000).toISOString(),
    );
  };
  const editCommitment = (value: CommitmentRecord) => {
    setCreatorOpen(true);
    setCommitmentEdit(value);
    setCommitment({
      title: value.title,
      startsAt: value.startsAt,
      endsAt: value.endsAt,
      kind: value.kind,
      location: value.location,
      travelBeforeMinutes: value.travelBeforeMinutes,
      travelAfterMinutes: value.travelAfterMinutes,
      protected: value.protected,
      expectedVersion: value.version,
    });
  };

  if (!workspace || !agenda)
    return (
      <div className="content workspace-page">
        <div className="loading">
          <strong>Loading your encrypted local records…</strong>
          {error && (
            <>
              <p role="alert">{error}</p>
              <button onClick={() => setReload((value) => value + 1)}>
                Retry loading Calendar
              </button>
            </>
          )}
        </div>
      </div>
    );

  return (
    <section
      className="content workspace-page mode-timetable"
      data-route="calendar"
      aria-label="Calendar workspace"
    >
      <div className="page-head">
        <div>
          <h1>Calendar</h1>
          <p>
            Your classes, protected time, and study blocks in one readable week.
          </p>
        </div>
        <div className="page-head-actions">
          <button
            className="outline"
            disabled={busy}
            onClick={() => setReload((value) => value + 1)}
          >
            Refresh
          </button>
          {selectedTask && (
            <button className="outline" onClick={() => setInspectorOpen(true)}>
              Open task inspector
            </button>
          )}
          <button className="solid" onClick={() => setCreatorOpen(true)}>
            <Plus /> Add event
          </button>
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
      <div
        className="workspace-grid calendar-layout"
        data-inspecting={Boolean(selectedTask && inspectorOpen && wide)}
      >
        <section className="workspace-panel">
          <div className="section-head">
            <h2>{range === "week" ? "Week calendar" : "Day calendar"}</h2>
            <div className="record-actions">
              <button
                aria-label="Previous week"
                disabled={busy}
                onClick={() => {
                  const day = shiftDay(days[0].key, -7);
                  setSelectedDay(day);
                  setWeekStart(day);
                }}
              >
                <ChevronLeft />
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  const day = dateKey(new Date(), agenda.timezone);
                  setSelectedDay(day);
                  setWeekStart(mondayOf(day));
                }}
              >
                Today
              </button>
              <button
                aria-label="Next week"
                disabled={busy}
                onClick={() => {
                  const day = shiftDay(days[0].key, 7);
                  setSelectedDay(day);
                  setWeekStart(day);
                }}
              >
                <ChevronRight />
              </button>
              <button
                className="outline"
                disabled={busy}
                onClick={() => void agendaAct(undoCalendarChange)}
              >
                Undo move
              </button>
              {onConnections && (
                <button className="outline" onClick={onConnections}>
                  Canvas ·{" "}
                  {
                    canvasConnections.filter(
                      (item) => item.status !== "disconnected",
                    ).length
                  }
                </button>
              )}
              <button className="outline" onClick={onImport}>
                <Upload />
                Import schedule
              </button>
            </div>
          </div>
          <div className="calendar-view-controls">
            <div className="segmented" role="group" aria-label="Calendar range">
              <button
                className={range === "day" ? "active" : ""}
                aria-pressed={range === "day"}
                onClick={() => setRange("day")}
              >
                Day
              </button>
              <button
                className={range === "week" ? "active" : ""}
                aria-pressed={range === "week"}
                onClick={() => setRange("week")}
              >
                Week
              </button>
            </div>
            {range === "day" && (
              <label className="field compact-calendar-day">
                Day
                <select
                  value={selectedDay}
                  onChange={(event) => setSelectedDay(event.target.value)}
                >
                  {days.map((day) => (
                    <option key={day.key} value={day.key}>
                      {day.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <p className="field-help">
            All times in {agenda.timezone}. Select a task to open its details.{" "}
            Drag an unfinished study block to move it, or drag its bottom handle
            to resize it. Keyboard: focus a block and use ↑/↓ to move 15
            minutes, or Shift+↑/↓ to resize.
          </p>
          <TimeGrid
            agenda={agenda}
            days={visibleDays}
            range={range}
            busy={busy}
            moveBlock={moveBlock}
            nudgeBlock={nudgeBlock}
            onSelectTask={selectTask}
            selectedTaskId={selectedTaskId}
          />
          <details className="unscheduled-tray" aria-label="Unscheduled work">
            <summary>Unscheduled work · {unscheduled.length}</summary>
            {unscheduled.length ? (
              <div className="course-chip-list">
                {unscheduled.map((task) => (
                  <button
                    className="mode-pill"
                    key={task.id}
                    onClick={() => selectTask(task.id)}
                  >
                    {task.title} · {task.minutes} min
                  </button>
                ))}
              </div>
            ) : (
              <p className="field-help">
                All feasible unfinished work has a study block.
              </p>
            )}
          </details>
          {agenda.overloadConflicts.map((conflict) => (
            <div className="alert" role="alert" key={conflict.id}>
              <CircleAlert />
              <span>{conflict.description}</span>
            </div>
          ))}
          <details className="calendar-list-alternative">
            <summary>Accessible agenda list</summary>
            <AgendaList
              agenda={agenda}
              busy={busy}
              onSelectTask={selectTask}
              lock={(id, locked) =>
                void agendaAct(() => setPlanBlockLock(id, locked))
              }
            />
          </details>
          <div className="section-head subhead">
            <h3>Fixed commitments</h3>
            <span>{workspace.commitments.length}</span>
          </div>
          {workspace.commitments.length ? (
            <div className="record-list">
              {workspace.commitments.map((item) => (
                <article key={item.id}>
                  <div className={`record-icon ${item.kind}`}>
                    <CalendarDays />
                  </div>
                  <div>
                    <strong>{item.title}</strong>
                    <small>
                      {formatDateTime(item.startsAt, agenda.timezone)} –{" "}
                      {formatTime(item.endsAt, agenda.timezone)}
                    </small>
                    <small>
                      {item.location || "No location"} ·{" "}
                      {item.travelBeforeMinutes + item.travelAfterMinutes}{" "}
                      travel minutes ·{" "}
                      {item.protected ? "Protected" : "Flexible"}
                    </small>
                  </div>
                  <div className="record-actions">
                    <button
                      className="outline"
                      onClick={() => editCommitment(item)}
                    >
                      Edit
                    </button>
                    <button
                      className="text-button danger"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Delete ${item.title}?`))
                          void act(() =>
                            deleteCommitment(item.id, item.version),
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
              <CalendarDays />
              <strong>No fixed commitments yet</strong>
              <p>
                Add classes, work, or protected time. Coqui keeps plans out of
                those windows.
              </p>
            </div>
          )}
          <div className="section-head subhead">
            <h3>Academic calendar</h3>
            <span>{workspace.academicEvents.length}</span>
          </div>
          {workspace.academicEvents.length ? (
            <div className="record-list compact">
              {workspace.academicEvents.map((item) => (
                <article key={item.id}>
                  <div className="record-icon protected">
                    <CalendarDays />
                  </div>
                  <div>
                    <strong>{item.title}</strong>
                    <small>
                      {item.startsOn}
                      {item.endsOn !== item.startsOn
                        ? ` – ${item.endsOn}`
                        : ""}{" "}
                      · {item.noClass ? "No classes" : "Academic event"}
                    </small>
                  </div>
                  <div className="record-actions">
                    <button
                      className="outline"
                      onClick={() => {
                        setCreatorOpen(true);
                        setAcademicEventEdit(item);
                        setAcademicEvent({
                          title: item.title,
                          startsOn: item.startsOn,
                          endsOn: item.endsOn,
                          allDay: item.allDay,
                          noClass: item.noClass,
                          source: item.source,
                        });
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="text-button danger"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Delete ${item.title}?`))
                          void act(() =>
                            deleteAcademicEvent(item.id, item.version),
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
            <p className="section-empty-copy">
              No holidays or no-class days added yet.
            </p>
          )}
        </section>
        {selectedTask && inspectorOpen && wide && (
          <TodayTaskInspector
            task={selectedTask}
            workspace={workspace}
            blocks={agenda.blocks}
            day={selectedDay}
            timezone={agenda.timezone}
            busy={busy}
            onClose={() => setInspectorOpen(false)}
            onEdit={(id) => onEditTask?.(id)}
            onComplete={(id) =>
              void act(async () => {
                await toggleTask(id);
                return getLocalWorkspace();
              })
            }
            onStart={(id) => void agendaAct(() => startPlanBlock(id))}
          />
        )}
      </div>
      {selectedTask && inspectorOpen && !wide && (
        <Modal
          title="Task inspector"
          subtitle="Task details and planning"
          close={() => setInspectorOpen(false)}
          className="calendar-task-drawer"
        >
          <TodayTaskInspector
            embedded
            task={selectedTask}
            workspace={workspace}
            blocks={agenda.blocks}
            day={selectedDay}
            timezone={agenda.timezone}
            busy={busy}
            onClose={() => setInspectorOpen(false)}
            onEdit={(id) => onEditTask?.(id)}
            onComplete={(id) =>
              void act(async () => {
                await toggleTask(id);
                return getLocalWorkspace();
              })
            }
            onStart={(id) => void agendaAct(() => startPlanBlock(id))}
          />
        </Modal>
      )}
      {creatorOpen && (
        <Modal
          title="Calendar event"
          subtitle="Add or edit protected time and academic dates."
          close={() => {
            if (!busy) setCreatorOpen(false);
          }}
        >
          {error && <p role="alert">{error}</p>}
          <CalendarInspector
            workspace={workspace}
            commitment={commitment}
            commitmentEdit={commitmentEdit}
            academicEvent={academicEvent}
            academicEventEdit={academicEventEdit}
            busy={busy}
            setCommitment={setCommitment}
            setCommitmentEdit={setCommitmentEdit}
            setAcademicEvent={setAcademicEvent}
            setAcademicEventEdit={setAcademicEventEdit}
            act={act}
          />
        </Modal>
      )}
    </section>
  );
}

function TimeGrid({
  agenda,
  days,
  range,
  busy,
  moveBlock,
  nudgeBlock,
  onSelectTask,
  selectedTaskId,
}: {
  agenda: CalendarAgenda;
  days: { key: string; label: string; blocks: CalendarAgenda["blocks"] }[];
  range: "day" | "week";
  busy: boolean;
  onSelectTask: (id: string) => void;
  selectedTaskId?: string | null;
  moveBlock: (id: string, start: string, end: string) => void;
  nudgeBlock: (
    block: CalendarAgenda["blocks"][number],
    delta: number,
    resize: boolean,
  ) => void;
}) {
  return (
    <div
      className="calendar-grid-scroll"
      role="region"
      aria-label="Scrollable calendar"
      tabIndex={0}
    >
      <div className="calendar-hours" aria-hidden="true">
        {Array.from({ length: 17 }, (_, index) => (
          <span key={index} style={{ top: 32 + index * 48 }}>
            {clockLabel(360 + index * 60)}
          </span>
        ))}
      </div>
      <div
        className={`week-calendar time-grid ${range === "day" ? "day-calendar" : ""}`}
        aria-label={`${range === "week" ? "Seven-day" : "Single-day"} time grid from 6 AM to 10 PM`}
      >
        {days.map((day) => (
          <section
            key={day.key}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const block = agenda.blocks.find(
                (item) =>
                  item.id === event.dataTransfer.getData("text/coqui-block"),
              );
              if (!block?.taskId || block.locked || block.completed || busy)
                return;
              const rect = event.currentTarget.getBoundingClientRect();
              const minute = Math.max(
                360,
                Math.min(
                  1320,
                  Math.round(
                    (360 + ((event.clientY - rect.top - 32) / 48) * 60) / 15,
                  ) * 15,
                ),
              );
              if (
                event.dataTransfer.getData("text/coqui-action") === "resize"
              ) {
                if (day.key !== dateKey(block.startsAt, agenda.timezone))
                  return;
                moveBlock(
                  block.id,
                  block.startsAt,
                  localToIso(
                    day.key,
                    Math.max(
                      minuteOfDay(block.startsAt, agenda.timezone) + 15,
                      minute,
                    ),
                    agenda.timezone,
                  ),
                );
              } else {
                const startsAt = localToIso(
                  day.key,
                  Math.min(1305, minute),
                  agenda.timezone,
                );
                moveBlock(
                  block.id,
                  startsAt,
                  new Date(
                    new Date(startsAt).getTime() +
                      minutesBetween(block.startsAt, block.endsAt) * 60_000,
                  ).toISOString(),
                );
              }
            }}
          >
            <h3>{day.label}</h3>
            {day.blocks.length ? (
              positionBlocks(day.blocks, day.key, agenda.timezone).map(
                ({ block, start, end, lane, lanes }) => (
                  <div
                    className={`week-block ${block.kind}`}
                    key={block.id}
                    role={block.taskId ? "button" : undefined}
                    tabIndex={block.taskId ? 0 : undefined}
                    draggable={
                      Boolean(block.taskId) &&
                      !block.locked &&
                      !block.completed &&
                      !busy
                    }
                    aria-pressed={
                      block.taskId ? block.taskId === selectedTaskId : undefined
                    }
                    onClick={() => {
                      if (block.taskId) onSelectTask(block.taskId);
                    }}
                    aria-label={
                      block.taskId
                        ? `${block.title}, ${formatTime(block.startsAt, agenda.timezone)}, ${minutesBetween(block.startsAt, block.endsAt)} minutes, ${block.locked ? "locked" : "flexible"}`
                        : undefined
                    }
                    onDragStart={(event) => {
                      if (
                        block.taskId &&
                        !block.locked &&
                        !block.completed &&
                        !busy
                      ) {
                        event.dataTransfer.setData(
                          "text/coqui-block",
                          block.id,
                        );
                        event.dataTransfer.setData("text/coqui-action", "move");
                        event.dataTransfer.effectAllowed = "move";
                      }
                    }}
                    onKeyDown={(event) => {
                      if (block.taskId && ["Enter", " "].includes(event.key)) {
                        event.preventDefault();
                        onSelectTask(block.taskId);
                        return;
                      }
                      if (
                        !block.taskId ||
                        block.locked ||
                        block.completed ||
                        busy ||
                        !["ArrowUp", "ArrowDown"].includes(event.key)
                      )
                        return;
                      event.preventDefault();
                      nudgeBlock(
                        block,
                        event.key === "ArrowUp" ? -15 : 15,
                        event.shiftKey,
                      );
                    }}
                    style={{
                      top: `${32 + Math.max(0, ((start - 360) / 60) * 48)}px`,
                      minHeight: `${Math.max(30, ((Math.min(1320, end) - Math.max(360, start)) / 60) * 48)}px`,
                      left: `calc(${(lane / lanes) * 100}% + 3px)`,
                      width: `calc(${100 / lanes}% - 6px)`,
                      right: "auto",
                    }}
                  >
                    <time>{formatTime(block.startsAt, agenda.timezone)}</time>
                    <strong>{block.title}</strong>
                    <small>
                      {minutesBetween(block.startsAt, block.endsAt)} min
                    </small>
                    {block.taskId && !block.locked && !block.completed && (
                      <span
                        className="calendar-resize-handle"
                        aria-hidden="true"
                        title={`Drag to resize ${block.title}`}
                        draggable={!busy}
                        onDragStart={(event) => {
                          event.stopPropagation();
                          event.dataTransfer.setData(
                            "text/coqui-block",
                            block.id,
                          );
                          event.dataTransfer.setData(
                            "text/coqui-action",
                            "resize",
                          );
                          event.dataTransfer.effectAllowed = "move";
                        }}
                      />
                    )}
                  </div>
                ),
              )
            ) : (
              <p>Open</p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

function AgendaList({
  agenda,
  busy,
  lock,
  onSelectTask,
}: {
  agenda: CalendarAgenda;
  busy: boolean;
  lock: (id: string, locked: boolean) => void;
  onSelectTask: (id: string) => void;
}) {
  if (!agenda.blocks.length)
    return (
      <div className="empty-state">
        <CalendarDays />
        <strong>No planned blocks this week</strong>
        <p>
          Add a task or commitment. Feasible work appears here without overlaps.
        </p>
      </div>
    );
  return (
    <>
      <h3 className="agenda-fallback-title">Agenda view</h3>
      <ol
        className="record-list calendar-agenda"
        aria-label="Seven-day agenda view"
      >
        {agenda.blocks.map((item) => (
          <li key={item.id}>
            <article className={item.completed ? "record-complete" : ""}>
              <div className={`record-icon ${item.kind}`}>
                <CalendarDays />
              </div>
              <div>
                {item.taskId ? (
                  <button
                    className="text-button"
                    onClick={() => onSelectTask(item.taskId!)}
                  >
                    {item.title}
                  </button>
                ) : (
                  <strong>{item.title}</strong>
                )}
                <small>
                  {formatDateTime(item.startsAt, agenda.timezone)} –{" "}
                  {formatTime(item.endsAt, agenda.timezone)} ·{" "}
                  {minutesBetween(item.startsAt, item.endsAt)} min
                </small>
                <small>
                  {item.location || "Any location"} ·{" "}
                  {item.locked ? "Locked" : "Flexible"} ·{" "}
                  {item.reasonCodes
                    .slice(0, 2)
                    .map((reason) => reason.replaceAll("_", " "))
                    .join(" · ")}
                </small>
              </div>
              {item.taskId && !item.completed && (
                <div className="record-actions">
                  <button
                    className="outline"
                    disabled={busy}
                    aria-pressed={item.locked}
                    onClick={() => lock(item.id, !item.locked)}
                  >
                    {item.locked ? "Unlock" : "Lock"}
                  </button>
                </div>
              )}
            </article>
          </li>
        ))}
      </ol>
    </>
  );
}
