import { useEffect, useMemo, useState } from "react";
import { CalendarDays, CircleAlert, HardDrive, Upload, X } from "lucide-react";
import {
  createAcademicEvent,
  createCommitment,
  deleteAcademicEvent,
  deleteCommitment,
  getCalendarAgenda,
  getDashboard,
  getLocalWorkspace,
  movePlanBlock,
  setPlanBlockLock,
  undoCalendarChange,
  updateAcademicEvent,
  updateCommitment,
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

const formatTime = (iso: string) =>
  new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );
const formatDateTime = (iso: string) =>
  new Intl.DateTimeFormat([], {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
const minutesBetween = (from: string, to: string) =>
  Math.max(
    0,
    Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000),
  );
const localValue = (value?: string) =>
  value ? new Date(value).toISOString().slice(0, 16) : "";
const dateKey = (value: string | Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(typeof value === "string" ? new Date(value) : value);
  const part = (type: "year" | "month" | "day") =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};
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
const localToIso = (day: string, minutes: number, timezone: string) => {
  const desired = Date.parse(
    `${day}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00Z`,
  );
  let guess = desired;
  for (let index = 0; index < 3; index += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const part = (type: string) =>
      Number(parts.find((item) => item.type === type)?.value ?? 0);
    guess +=
      desired -
      Date.UTC(
        part("year"),
        part("month") - 1,
        part("day"),
        part("hour"),
        part("minute"),
      );
  }
  return new Date(guess).toISOString();
};
const emptyCommitment = (): CommitmentEditorInput => ({
  title: "",
  startsAt: "",
  endsAt: "",
  kind: "class",
  location: "",
  travelBeforeMinutes: 0,
  travelAfterMinutes: 0,
  protected: true,
});
const emptyAcademicEvent = (): AcademicCalendarEventInput => {
  const today = new Date().toISOString().slice(0, 10);
  return {
    title: "",
    startsOn: today,
    endsOn: today,
    allDay: true,
    noClass: true,
    source: "user",
  };
};

export function CalendarView({
  onDashboard,
  onImport,
  onConnections,
  canvasConnections = [],
}: WorkspaceRouteProps) {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [agenda, setAgenda] = useState<CalendarAgenda | null>(null);
  const [range, setRange] = useState<"day" | "week">("week");
  const [selectedDay, setSelectedDay] = useState("");
  const [commitment, setCommitment] =
    useState<CommitmentEditorInput>(emptyCommitment);
  const [commitmentEdit, setCommitmentEdit] = useState<CommitmentRecord | null>(
    null,
  );
  const [academicEvent, setAcademicEvent] =
    useState<AcademicCalendarEventInput>(emptyAcademicEvent);
  const [academicEventEdit, setAcademicEventEdit] =
    useState<AcademicCalendarEventRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void Promise.all([getLocalWorkspace(), getCalendarAgenda()])
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
  }, []);

  const refresh = async (nextWorkspace?: WorkspaceSnapshot) => {
    if (nextWorkspace) setWorkspace(nextWorkspace);
    setAgenda(await getCalendarAgenda());
    onDashboard(await getDashboard());
  };
  const act = async (operation: () => Promise<WorkspaceSnapshot>) => {
    setBusy(true);
    setError("");
    try {
      await refresh(await operation());
    } catch (reason) {
      setError(String(reason));
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
    const start = new Date(agenda.startsAt);
    return Array.from({ length: 7 }, (_, index) => {
      const sample = new Date(
        start.getTime() + index * 86_400_000 + 12 * 3_600_000,
      );
      const key = dateKey(sample, agenda.timezone);
      return {
        key,
        label: new Intl.DateTimeFormat([], {
          timeZone: agenda.timezone,
          weekday: "short",
          month: "short",
          day: "numeric",
        }).format(sample),
        blocks: agenda.blocks.filter(
          (block) => dateKey(block.startsAt, agenda.timezone) === key,
        ),
      };
    });
  }, [agenda]);
  useEffect(() => {
    if (!days.length || days.some((day) => day.key === selectedDay)) return;
    const today = dateKey(new Date(), agenda?.timezone ?? "UTC");
    setSelectedDay(days.find((day) => day.key === today)?.key ?? days[0].key);
  }, [agenda?.timezone, days, selectedDay]);
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
          {error && <p>{error}</p>}
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
          <p className="eyebrow">Plan and protect your time</p>
          <h1>Calendar</h1>
          <p>
            Your classes, protected time, and study blocks in one readable week.
          </p>
        </div>
        <span className="mode-pill">
          <HardDrive />
          Local authority
        </span>
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
      <div className="workspace-grid">
        <section className="workspace-panel">
          <div className="section-head">
            <h2>{range === "week" ? "Week calendar" : "Day calendar"}</h2>
            <div className="record-actions">
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
          />
          <section className="unscheduled-tray" aria-label="Unscheduled work">
            <div className="section-head">
              <h3>Unscheduled work</h3>
              <span>{unscheduled.length}</span>
            </div>
            {unscheduled.length ? (
              <div className="course-chip-list">
                {unscheduled.map((task) => (
                  <span className="mode-pill" key={task.id}>
                    {task.title} · {task.minutes} min
                  </span>
                ))}
              </div>
            ) : (
              <p className="field-help">
                All feasible unfinished work has a study block.
              </p>
            )}
          </section>
          {agenda.overloadConflicts.map((conflict) => (
            <div className="alert" role="alert" key={conflict.id}>
              <CircleAlert />
              <span>{conflict.description}</span>
            </div>
          ))}
          <AgendaList
            agenda={agenda}
            busy={busy}
            lock={(id, locked) =>
              void agendaAct(() => setPlanBlockLock(id, locked))
            }
          />
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
                      {formatDateTime(item.startsAt)} –{" "}
                      {formatTime(item.endsAt)}
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
      </div>
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
}: {
  agenda: CalendarAgenda;
  days: { key: string; label: string; blocks: CalendarAgenda["blocks"] }[];
  range: "day" | "week";
  busy: boolean;
  moveBlock: (id: string, start: string, end: string) => void;
  nudgeBlock: (
    block: CalendarAgenda["blocks"][number],
    delta: number,
    resize: boolean,
  ) => void;
}) {
  return (
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
            if (!block?.taskId || block.locked) return;
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
            if (event.dataTransfer.getData("text/coqui-action") === "resize") {
              if (day.key !== dateKey(block.startsAt, agenda.timezone)) return;
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
            day.blocks.map((block) => (
              <div
                className={`week-block ${block.kind}`}
                key={block.id}
                role={block.taskId ? "button" : undefined}
                tabIndex={block.taskId ? 0 : undefined}
                draggable={Boolean(block.taskId) && !block.locked && !busy}
                aria-label={
                  block.taskId
                    ? `${block.title}, ${formatTime(block.startsAt)}, ${minutesBetween(block.startsAt, block.endsAt)} minutes, ${block.locked ? "locked" : "flexible"}`
                    : undefined
                }
                onDragStart={(event) => {
                  if (block.taskId && !block.locked) {
                    event.dataTransfer.setData("text/coqui-block", block.id);
                    event.dataTransfer.setData("text/coqui-action", "move");
                    event.dataTransfer.effectAllowed = "move";
                  }
                }}
                onKeyDown={(event) => {
                  if (
                    !block.taskId ||
                    block.locked ||
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
                  top: `${32 + Math.max(0, ((minuteOfDay(block.startsAt, agenda.timezone) - 360) / 60) * 48)}px`,
                  minHeight: `${Math.max(30, (minutesBetween(block.startsAt, block.endsAt) / 60) * 48)}px`,
                }}
              >
                <time>{formatTime(block.startsAt)}</time>
                <strong>{block.title}</strong>
                <small>
                  {minutesBetween(block.startsAt, block.endsAt)} min
                </small>
                {block.taskId && !block.locked && (
                  <span
                    className="calendar-resize-handle"
                    aria-hidden="true"
                    title={`Drag to resize ${block.title}`}
                    draggable={!busy}
                    onDragStart={(event) => {
                      event.stopPropagation();
                      event.dataTransfer.setData("text/coqui-block", block.id);
                      event.dataTransfer.setData("text/coqui-action", "resize");
                      event.dataTransfer.effectAllowed = "move";
                    }}
                  />
                )}
              </div>
            ))
          ) : (
            <p>Open</p>
          )}
        </section>
      ))}
    </div>
  );
}

function AgendaList({
  agenda,
  busy,
  lock,
}: {
  agenda: CalendarAgenda;
  busy: boolean;
  lock: (id: string, locked: boolean) => void;
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
                <strong>{item.title}</strong>
                <small>
                  {formatDateTime(item.startsAt)} – {formatTime(item.endsAt)} ·{" "}
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

function CalendarInspector({
  workspace,
  commitment,
  commitmentEdit,
  academicEvent,
  academicEventEdit,
  busy,
  setCommitment,
  setCommitmentEdit,
  setAcademicEvent,
  setAcademicEventEdit,
  act,
}: {
  workspace: WorkspaceSnapshot;
  commitment: CommitmentEditorInput;
  commitmentEdit: CommitmentRecord | null;
  academicEvent: AcademicCalendarEventInput;
  academicEventEdit: AcademicCalendarEventRecord | null;
  busy: boolean;
  setCommitment: React.Dispatch<React.SetStateAction<CommitmentEditorInput>>;
  setCommitmentEdit: (value: CommitmentRecord | null) => void;
  setAcademicEvent: React.Dispatch<
    React.SetStateAction<AcademicCalendarEventInput>
  >;
  setAcademicEventEdit: (value: AcademicCalendarEventRecord | null) => void;
  act: (operation: () => Promise<WorkspaceSnapshot>) => Promise<void>;
}) {
  return (
    <aside className="workspace-panel editor calendar-inspector">
      <h2>{commitmentEdit ? "Edit commitment" : "Add commitment"}</h2>
      <label className="field">
        Title
        <input
          value={commitment.title}
          onChange={(event) =>
            setCommitment((current) => ({
              ...current,
              title: event.target.value,
            }))
          }
          placeholder="Chemistry lab"
        />
      </label>
      <div className="form-grid">
        <label className="field">
          Starts
          <input
            type="datetime-local"
            value={localValue(commitment.startsAt)}
            onChange={(event) =>
              setCommitment((current) => ({
                ...current,
                startsAt: event.target.value
                  ? new Date(event.target.value).toISOString()
                  : "",
              }))
            }
          />
        </label>
        <label className="field">
          Ends
          <input
            type="datetime-local"
            value={localValue(commitment.endsAt)}
            onChange={(event) =>
              setCommitment((current) => ({
                ...current,
                endsAt: event.target.value
                  ? new Date(event.target.value).toISOString()
                  : "",
              }))
            }
          />
        </label>
        <label className="field">
          Type
          <select
            value={commitment.kind}
            onChange={(event) =>
              setCommitment((current) => ({
                ...current,
                kind: event.target.value as CommitmentEditorInput["kind"],
              }))
            }
          >
            <option value="class">Class</option>
            <option value="work">Work</option>
            <option value="life">Life</option>
            <option value="protected">Protected time</option>
          </select>
        </label>
        <label className="field">
          Location
          <input
            value={commitment.location}
            onChange={(event) =>
              setCommitment((current) => ({
                ...current,
                location: event.target.value,
              }))
            }
          />
        </label>
        <label className="field">
          Travel before
          <input
            type="number"
            min="0"
            max="240"
            step="5"
            value={commitment.travelBeforeMinutes}
            onChange={(event) =>
              setCommitment((current) => ({
                ...current,
                travelBeforeMinutes: Number(event.target.value),
              }))
            }
          />
        </label>
        <label className="field">
          Travel after
          <input
            type="number"
            min="0"
            max="240"
            step="5"
            value={commitment.travelAfterMinutes}
            onChange={(event) =>
              setCommitment((current) => ({
                ...current,
                travelAfterMinutes: Number(event.target.value),
              }))
            }
          />
        </label>
      </div>
      <label className="setting-toggle compact">
        <input
          type="checkbox"
          checked={commitment.protected}
          onChange={(event) =>
            setCommitment((current) => ({
              ...current,
              protected: event.target.checked,
            }))
          }
        />
        <span>
          <strong>Protect this time during replanning</strong>
          <small>Fixed commitments are never overlapped.</small>
        </span>
      </label>
      <div className="modal-actions">
        {commitmentEdit && (
          <button
            className="outline"
            onClick={() => {
              setCommitmentEdit(null);
              setCommitment(emptyCommitment());
            }}
          >
            Cancel
          </button>
        )}
        <button
          className="solid"
          disabled={
            busy ||
            !commitment.title.trim() ||
            !commitment.startsAt ||
            !commitment.endsAt
          }
          onClick={() =>
            void act(() =>
              commitmentEdit
                ? updateCommitment(commitmentEdit.id, commitment)
                : createCommitment(commitment),
            ).then(() => {
              setCommitmentEdit(null);
              setCommitment(emptyCommitment());
            })
          }
        >
          {commitmentEdit ? "Save changes" : "Add commitment"}
        </button>
      </div>
      <div className="editor-divider" />
      <h2>
        {academicEventEdit
          ? "Edit academic event"
          : "Add a holiday or no-class day"}
      </h2>
      <label className="field">
        Title
        <input
          value={academicEvent.title}
          onChange={(event) =>
            setAcademicEvent((current) => ({
              ...current,
              title: event.target.value,
            }))
          }
          placeholder="Fall break"
        />
      </label>
      <div className="form-grid">
        <label className="field">
          Starts
          <input
            type="date"
            value={academicEvent.startsOn}
            onChange={(event) =>
              setAcademicEvent((current) => ({
                ...current,
                startsOn: event.target.value,
                endsOn:
                  current.endsOn < event.target.value
                    ? event.target.value
                    : current.endsOn,
              }))
            }
          />
        </label>
        <label className="field">
          Ends
          <input
            type="date"
            value={academicEvent.endsOn}
            onChange={(event) =>
              setAcademicEvent((current) => ({
                ...current,
                endsOn: event.target.value,
              }))
            }
          />
        </label>
      </div>
      <label className="setting-toggle compact">
        <input
          type="checkbox"
          checked={academicEvent.noClass}
          onChange={(event) =>
            setAcademicEvent((current) => ({
              ...current,
              noClass: event.target.checked,
            }))
          }
        />
        <span>
          <strong>No classes or schedulable work</strong>
          <small>Coqui treats this as protected capacity.</small>
        </span>
      </label>
      <div className="modal-actions">
        {academicEventEdit && (
          <button
            className="outline"
            onClick={() => {
              setAcademicEventEdit(null);
              setAcademicEvent(emptyAcademicEvent());
            }}
          >
            Cancel
          </button>
        )}
        <button
          className="solid"
          disabled={busy || !academicEvent.title.trim()}
          onClick={() => {
            const input = {
              ...academicEvent,
              termId: workspace.terms.find((value) => value.active)?.id,
            };
            void act(() =>
              academicEventEdit
                ? updateAcademicEvent(academicEventEdit.id, {
                    ...input,
                    expectedVersion: academicEventEdit.version,
                  })
                : createAcademicEvent(input),
            ).then(() => {
              setAcademicEventEdit(null);
              setAcademicEvent(emptyAcademicEvent());
            });
          }}
        >
          {academicEventEdit ? "Save academic event" : "Add academic event"}
        </button>
      </div>
    </aside>
  );
}
