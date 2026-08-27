import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Brain,
  CalendarDays,
  CircleAlert,
  HardDrive,
  ListChecks,
  Upload,
  X,
} from "lucide-react";
import {
  AcademicCalendarEventInput,
  CalendarAgenda,
  CanvasConnection,
  CommitmentEditorInput,
  CommitmentRecord,
  CourseInput,
  CourseRecord,
  createCommitment,
  createAcademicEvent,
  createAcademicTerm,
  createClassMeeting,
  createCourse,
  createInstructor,
  createLocalTask,
  AcademicCalendarEventRecord,
  AcademicTermInput,
  AcademicTermRecord,
  ClassMeetingSeriesRecord,
  InstructorRecord,
  Dashboard,
  deleteAcademicEvent,
  deleteAcademicTerm,
  deleteClassMeeting,
  deleteCommitment,
  deleteCourse,
  deleteInstructor,
  deleteLocalTask,
  getCalendarAgenda,
  getDashboard,
  getLocalWorkspace,
  getStudyWorkspace,
  PreferenceInput,
  setPlanBlockLock,
  movePlanBlock,
  undoCalendarChange,
  TaskInput,
  TaskRecord,
  updateCommitment,
  updateAcademicEvent,
  updateAcademicTerm,
  updateClassMeeting,
  updateCourse,
  updateInstructor,
  updateLocalTask,
  updatePlanningPreferences,
  updateStudentProfile,
  WorkspaceSnapshot,
  StudyWorkspace,
  searchCourseSuggestions,
  CourseSuggestion,
} from "../native";

const formatTime = (iso: string) =>
  new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const formatDateTime = (iso?: string) =>
  iso ? new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "Not set";
const minutesBetween = (from: string, to: string) =>
  Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000));
const zonedDateKey = (value: string | Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(typeof value === "string" ? new Date(value) : value);
  const part = (type: "year" | "month" | "day") => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};
const zonedMinuteOfDay = (value: string, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const number = (type: "hour" | "minute") => Number(parts.find((item) => item.type === type)?.value ?? 0);
  return number("hour") * 60 + number("minute");
};
const zonedLocalToIso = (dateKey: string, minutes: number, timezone: string) => {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const desired = Date.parse(`${dateKey}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  let guess = desired;
  for (let index = 0; index < 3; index += 1) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? 0);
    const represented = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
    guess += desired - represented;
  }
  return new Date(guess).toISOString();
};
const courseNameFor = (courses: CourseRecord[], id: string) => {
  const course = courses.find((item) => item.id === id);
  return course ? course.code || course.title : "Course";
};

export type WorkspaceRouteProps = {
  onDashboard: (dashboard: Dashboard) => void;
  onImport: () => void;
  onStudy: () => void;
  onConnections?: () => void;
  canvasConnections?: CanvasConnection[];
};

export function WorkspaceView({
  mode,
  onDashboard,
  onImport,
  onStudy,
  onConnections,
  canvasConnections = [],
}: WorkspaceRouteProps & {
  mode: "timetable" | "assignments" | "courses" | "settings";
}) {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [studyWorkspace, setStudyWorkspace] = useState<StudyWorkspace | null>(null);
  const [agenda, setAgenda] = useState<CalendarAgenda | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [courseEdit, setCourseEdit] = useState<CourseRecord | null>(null);
  const [selectedCourseId, setSelectedCourseId] = useState("");
  const [courseTab, setCourseTab] = useState<"overview"|"work"|"schedule"|"materials"|"grades">("overview");
  const [course, setCourse] = useState<CourseInput>({ title: "", code: "" });
  // Adding a course mid-semester had no autocomplete at all, so a code typed
  // here never reached the school catalog that onboarding already uses.
  const [courseSuggestions, setCourseSuggestions] = useState<CourseSuggestion[]>([]);
  const emptyTask: TaskInput = {
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
  };
  const [taskEdit, setTaskEdit] = useState<TaskRecord | null>(null);
  const [workFilter, setWorkFilter] = useState<"inbox"|"upcoming"|"overdue"|"exams"|"completed">("upcoming");
  const [calendarRange, setCalendarRange] = useState<"day" | "week">("week");
  const [calendarDay, setCalendarDay] = useState("");
  const [task, setTask] = useState<TaskInput>(emptyTask);
  const emptyCommitment: CommitmentEditorInput = {
    title: "",
    startsAt: "",
    endsAt: "",
    kind: "class",
    location: "",
    travelBeforeMinutes: 0,
    travelAfterMinutes: 0,
    protected: true,
  };
  const [commitmentEdit, setCommitmentEdit] = useState<CommitmentRecord | null>(
    null,
  );
  const [commitment, setCommitment] =
    useState<CommitmentEditorInput>(emptyCommitment);
  const emptyAcademicEvent: AcademicCalendarEventInput = {
    title: "",
    startsOn: new Date().toISOString().slice(0, 10),
    endsOn: new Date().toISOString().slice(0, 10),
    allDay: true,
    noClass: true,
    source: "user",
  };
  const [academicEvent, setAcademicEvent] =
    useState<AcademicCalendarEventInput>(emptyAcademicEvent);
  const [academicEventEdit, setAcademicEventEdit] =
    useState<AcademicCalendarEventRecord | null>(null);
  const emptyInstructor = { courseId: "", name: "", email: "", officeLocation: "", officeHours: "" };
  const emptyMeeting = { courseId: "", weekdays: [1, 3, 5], startsAtLocal: "09:00", endsAtLocal: "09:50", component: "lecture", location: "", modality: "" };
  const [instructorDraft, setInstructorDraft] = useState(emptyInstructor);
  const [instructorEdit, setInstructorEdit] = useState<InstructorRecord | null>(null);
  const [meetingDraft, setMeetingDraft] = useState(emptyMeeting);
  const [meetingEdit, setMeetingEdit] = useState<ClassMeetingSeriesRecord | null>(null);
  const emptyTerm: AcademicTermInput = { name: "", startsOn: "", endsOn: "", active: true };
  const [term, setTerm] = useState<AcademicTermInput>(emptyTerm);
  const [termEdit, setTermEdit] = useState<AcademicTermRecord | null>(null);
  const [preferences, setPreferences] = useState<PreferenceInput | null>(null);
  const [profileEditor, setProfileEditor] = useState({
    name: "",
    timezone: "",
    expectedVersion: 0,
  });
  useEffect(() => {
    let active = true;
    setWorkspace(null);
    Promise.all([
      getLocalWorkspace(),
      mode === "timetable" ? getCalendarAgenda() : Promise.resolve(null),
      mode === "courses" ? getStudyWorkspace() : Promise.resolve(null),
    ])
      .then(([next, nextAgenda, nextStudyWorkspace]) => {
        if (active) {
          setWorkspace(next);
          setStudyWorkspace(nextStudyWorkspace);
          setSelectedCourseId((current) => next.courses.some((course)=>course.id===current) ? current : next.courses[0]?.id ?? "");
          setAgenda(nextAgenda);
          if (next.profile)
            setProfileEditor({
              name: next.profile.name,
              timezone: next.profile.timezone,
              expectedVersion: next.profile.version,
            });
          if (next.preferences)
            setPreferences({
              ...next.preferences,
              expectedVersion: next.preferences.version,
              availability: next.availability,
            });
        }
      })
      .catch((next) => {
        if (active) setError(String(next));
      });
    return () => {
      active = false;
    };
  }, [mode]);
  const applied = async (next: WorkspaceSnapshot) => {
    setWorkspace(next);
    if (next.profile)
      setProfileEditor({
        name: next.profile.name,
        timezone: next.profile.timezone,
        expectedVersion: next.profile.version,
      });
    if (next.preferences)
      setPreferences({
        ...next.preferences,
        expectedVersion: next.preferences.version,
        availability: next.availability,
      });
    if (mode === "timetable") setAgenda(await getCalendarAgenda());
    // This runs only after a workspace mutation, so onboarding is already
    // complete and the lighter dashboard fetch is enough.
    onDashboard(await getDashboard());
  };
  const act = async (operation: () => Promise<WorkspaceSnapshot>) => {
    setBusy(true);
    setError("");
    try {
      await applied(await operation());
    } catch (next) {
      setError(String(next));
    } finally {
      setBusy(false);
    }
  };
  const editCourse = (value: CourseRecord) => {
    setCourseEdit(value);
    setCourse({
      title: value.title,
      code: value.code,
      termId: value.termId,
      expectedVersion: value.version,
    });
  };
  const editTask = (value: TaskRecord) => {
    setTaskEdit(value);
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
  const localValue = (value?: string) =>
    value ? new Date(value).toISOString().slice(0, 16) : "";
  const lockBlock = async (blockId: string, locked: boolean) => {
    setBusy(true);
    setError("");
    try {
      const dashboard = await setPlanBlockLock(blockId, locked);
      onDashboard(dashboard);
      setAgenda(await getCalendarAgenda());
    } catch (next) {
      setError(String(next));
    } finally {
      setBusy(false);
    }
  };
  const moveCalendarBlock = async (blockId: string, startsAt: string, endsAt: string) => {
    setBusy(true); setError("");
    try { const dashboard = await movePlanBlock(blockId, startsAt, endsAt); onDashboard(dashboard); setAgenda(await getCalendarAgenda()); }
    catch (next) { setError(String(next)); }
    finally { setBusy(false); }
  };
  const nudgeCalendarBlock = (block: CalendarAgenda["blocks"][number], deltaMinutes: number, resize = false) => {
    const start = new Date(block.startsAt).getTime(); const end = new Date(block.endsAt).getTime();
    void moveCalendarBlock(block.id, new Date(resize ? start : start + deltaMinutes * 60_000).toISOString(), new Date(end + deltaMinutes * 60_000).toISOString());
  };
  const undoCalendar = async () => {
    setBusy(true); setError("");
    try { const dashboard = await undoCalendarChange(); onDashboard(dashboard); setAgenda(await getCalendarAgenda()); }
    catch (next) { setError(String(next)); }
    finally { setBusy(false); }
  };
  const toggleAvailabilityDay = (weekday: number, enabled: boolean) =>
    setPreferences((current) =>
      current
        ? {
            ...current,
            availability: enabled
              ? [
                  ...current.availability,
                  { weekday, startsAtLocal: "08:00", endsAtLocal: "21:00" },
                ].sort((left, right) => left.weekday - right.weekday)
              : current.availability.filter((rule) => rule.weekday !== weekday),
          }
        : current,
    );
  const updateAvailabilityDay = (
    weekday: number,
    key: "startsAtLocal" | "endsAtLocal",
    value: string,
  ) =>
    setPreferences((current) =>
      current
        ? {
            ...current,
            availability: current.availability.map((rule) =>
              rule.weekday === weekday ? { ...rule, [key]: value } : rule,
            ),
          }
        : current,
    );
  const agendaDays = useMemo(() => {
    if (!agenda) return [];
    const start = new Date(agenda.startsAt);
    return Array.from({ length: 7 }, (_, index) => {
      const sample = new Date(start.getTime() + index * 86_400_000 + 12 * 3_600_000);
      const key = zonedDateKey(sample, agenda.timezone);
      return {
        key,
        label: new Intl.DateTimeFormat([], {
          timeZone: agenda.timezone,
          weekday: "short",
          month: "short",
          day: "numeric",
        }).format(sample),
        blocks: agenda.blocks.filter(
          (block) => zonedDateKey(block.startsAt, agenda.timezone) === key,
        ),
      };
    });
  }, [agenda]);
  useEffect(() => {
    if (!agendaDays.length) return;
    const today = zonedDateKey(new Date(), agenda?.timezone ?? "UTC");
    if (!agendaDays.some((day) => day.key === calendarDay)) {
      setCalendarDay(agendaDays.find((day) => day.key === today)?.key ?? agendaDays[0].key);
    }
  }, [agenda?.timezone, agendaDays, calendarDay]);
  const visibleAgendaDays = calendarRange === "week"
    ? agendaDays
    : agendaDays.filter((day) => day.key === calendarDay);
  const unscheduledWork = workspace?.tasks.filter(
    (task) => !task.completed && !agenda?.blocks.some((block) => block.taskId === task.id),
  ) ?? [];
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
    <div className={`content workspace-page mode-${mode}`}>
      <div className="page-head">
        <div>
          <p className="eyebrow">Account-free and offline</p>
          <h1>{mode === "timetable" ? "Calendar" : mode === "assignments" ? "Work" : mode === "settings" ? "Academic & planning settings" : "Courses"}</h1>
          <p>
            {mode === "timetable"
              ? "Your classes, protected time, and study blocks in one readable week."
              : mode === "assignments"
                ? "Inbox, upcoming work, overdue items, exams, and completed work."
                : mode === "settings"
                  ? "Manage terms, profile timezone, availability, and planning preferences."
                  : "Course details, work, schedule, materials, and grades."}
          </p>
        </div>
        <span className="mode-pill">
          <HardDrive /> Local authority
        </span>
      </div>
      {error && (
        <div className="alert" role="alert">
          <CircleAlert />
          <span>{error}</span>
          <button onClick={() => setError("")}>
            <X />
          </button>
        </div>
      )}
      {mode === "timetable" ? (
        <div className="workspace-grid">
          <section className="workspace-panel">
            <div className="section-head">
              <h2>{calendarRange === "week" ? "Week calendar" : "Day calendar"}</h2>
              <div className="record-actions">
                <button className="outline" disabled={busy} onClick={()=>void undoCalendar()}>Undo move</button>
                {onConnections && <button className="outline" onClick={onConnections}>Canvas · {canvasConnections.filter((item)=>item.status!=="disconnected").length}</button>}
                <button className="outline" onClick={onImport}><Upload /> Import schedule</button>
              </div>
            </div>
            <div className="calendar-view-controls">
              <div className="segmented" role="group" aria-label="Calendar range">
                <button className={calendarRange==="day"?"active":""} aria-pressed={calendarRange==="day"} onClick={()=>setCalendarRange("day")}>Day</button>
                <button className={calendarRange==="week"?"active":""} aria-pressed={calendarRange==="week"} onClick={()=>setCalendarRange("week")}>Week</button>
              </div>
              {calendarRange === "day" && <label className="field compact-calendar-day">Day<select value={calendarDay} onChange={(event)=>setCalendarDay(event.target.value)}>{agendaDays.map((day)=><option key={day.key} value={day.key}>{day.label}</option>)}</select></label>}
            </div>
            <p className="field-help">Drag an unfinished study block to move it, or drag its bottom handle to resize it. Keyboard: focus a block and use ↑/↓ to move 15 minutes, or Shift+↑/↓ to resize.</p>
            <div className={`week-calendar time-grid ${calendarRange === "day" ? "day-calendar" : ""}`} aria-label={`${calendarRange === "week" ? "Seven-day" : "Single-day"} time grid from 6 AM to 10 PM`}>
              {visibleAgendaDays.map((day) => (
                <section key={day.key} onDragOver={(event)=>event.preventDefault()} onDrop={(event)=>{event.preventDefault();const block=agenda?.blocks.find((item)=>item.id===event.dataTransfer.getData("text/coqui-block"));if(!block||!block.taskId||block.locked)return;const timezone=agenda?.timezone??"UTC";const rect=event.currentTarget.getBoundingClientRect();const raw=360+(event.clientY-rect.top-32)/48*60;const minute=Math.max(360,Math.min(1320,Math.round(raw/15)*15));if(event.dataTransfer.getData("text/coqui-action")==="resize"){if(day.key!==zonedDateKey(block.startsAt,timezone))return;const endMinute=Math.max(zonedMinuteOfDay(block.startsAt,timezone)+15,minute);void moveCalendarBlock(block.id,block.startsAt,zonedLocalToIso(day.key,endMinute,timezone));return;}const startsAt=zonedLocalToIso(day.key,Math.min(1305,minute),timezone);const endsAt=new Date(new Date(startsAt).getTime()+minutesBetween(block.startsAt,block.endsAt)*60_000).toISOString();void moveCalendarBlock(block.id,startsAt,endsAt);}}>
                  <h3>{day.label}</h3>
                  {day.blocks.length ? (
                    day.blocks.map((block) => (
                      <div
                        className={`week-block ${block.kind}`}
                        key={block.id}
                        role={block.taskId ? "button" : undefined}
                        tabIndex={block.taskId ? 0 : undefined}
                        draggable={Boolean(block.taskId) && !block.locked && !busy}
                        aria-label={block.taskId ? `${block.title}, ${formatTime(block.startsAt)}, ${minutesBetween(block.startsAt,block.endsAt)} minutes, ${block.locked?"locked":"flexible"}` : undefined}
                        onDragStart={(event)=>{if(block.taskId&&!block.locked){event.dataTransfer.setData("text/coqui-block",block.id);event.dataTransfer.setData("text/coqui-action","move");event.dataTransfer.effectAllowed="move";}}}
                        onKeyDown={(event)=>{if(!block.taskId||block.locked||!(["ArrowUp","ArrowDown"] as string[]).includes(event.key))return;event.preventDefault();const delta=event.key==="ArrowUp"?-15:15;nudgeCalendarBlock(block,delta,event.shiftKey);}}
                        style={{ top: `${32 + Math.max(0, (zonedMinuteOfDay(block.startsAt, agenda?.timezone ?? "UTC") - 360) / 60 * 48)}px`, minHeight: `${Math.max(30, minutesBetween(block.startsAt, block.endsAt) / 60 * 48)}px` }}
                      >
                        <time>{formatTime(block.startsAt)}</time>
                        <strong>{block.title}</strong>
                        <small>{minutesBetween(block.startsAt, block.endsAt)} min</small>
                        {block.taskId && !block.locked && <span
                          className="calendar-resize-handle"
                          aria-hidden="true"
                          title={`Drag to resize ${block.title}`}
                          draggable={!busy}
                          onDragStart={(event)=>{event.stopPropagation();event.dataTransfer.setData("text/coqui-block",block.id);event.dataTransfer.setData("text/coqui-action","resize");event.dataTransfer.effectAllowed="move";}}
                        />}
                      </div>
                    ))
                  ) : (
                    <p>Open</p>
                  )}
                </section>
              ))}
            </div>
            <section className="unscheduled-tray" aria-label="Unscheduled work"><div className="section-head"><h3>Unscheduled work</h3><span>{unscheduledWork.length}</span></div>{unscheduledWork.length?<div className="course-chip-list">{unscheduledWork.map((task)=><span className="mode-pill" key={task.id}>{task.title} · {task.minutes} min</span>)}</div>:<p className="field-help">All feasible unfinished work has a study block.</p>}</section>
            {agenda?.overloadConflicts.map((conflict) => (
              <div className="alert" role="alert" key={conflict.id}>
                <CircleAlert />
                <span>{conflict.description}</span>
              </div>
            ))}
            {agenda?.blocks.length ? (
              <><h3 className="agenda-fallback-title">Agenda view</h3><ol
                className="record-list calendar-agenda"
                aria-label="Seven-day agenda view"
              >
                {agenda.blocks.map((item) => (
                  <li key={item.id}>
                    <article
                      className={item.completed ? "record-complete" : ""}
                    >
                      <div className={`record-icon ${item.kind}`}>
                        <CalendarDays />
                      </div>
                      <div>
                        <strong>{item.title}</strong>
                        <small>
                          {formatDateTime(item.startsAt)} –{" "}
                          {formatTime(item.endsAt)} ·{" "}
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
                            onClick={() =>
                              void lockBlock(item.id, !item.locked)
                            }
                          >
                            {item.locked ? "Unlock" : "Lock"}
                          </button>
                        </div>
                      )}
                    </article>
                  </li>
                ))}
              </ol></>
            ) : (
              <div className="empty-state">
                <CalendarDays />
                <strong>No planned blocks this week</strong>
                <p>
                  Add a task or commitment. Feasible work will appear here
                  without overlaps.
                </p>
              </div>
            )}
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
                        {new Intl.DateTimeFormat([], {
                          timeStyle: "short",
                        }).format(new Date(item.endsAt))}
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
                  Add classes, work, or protected time. Student Center will keep
                  plans out of those windows.
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
                    <div className="record-icon protected"><CalendarDays /></div>
                    <div><strong>{item.title}</strong><small>{item.startsOn}{item.endsOn !== item.startsOn ? ` – ${item.endsOn}` : ""} · {item.noClass ? "No classes" : "Academic event"}</small></div>
                    <div className="record-actions">
                      <button className="outline" onClick={() => { setAcademicEventEdit(item); setAcademicEvent({ title: item.title, startsOn: item.startsOn, endsOn: item.endsOn, allDay: item.allDay, noClass: item.noClass, source: item.source }); }}>Edit</button>
                      <button className="text-button danger" disabled={busy} onClick={() => { if (window.confirm(`Delete ${item.title}?`)) void act(() => deleteAcademicEvent(item.id, item.version)); }}>Delete</button>
                    </div>
                  </article>
                ))}
              </div>
            ) : <p className="section-empty-copy">No holidays or no-class days added yet.</p>}
          </section>
          <section className="workspace-panel editor">
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
                    setCommitment(emptyCommitment);
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
                    setCommitment(emptyCommitment);
                  })
                }
              >
                {commitmentEdit ? "Save changes" : "Add commitment"}
              </button>
            </div>
            <div className="editor-divider" />
            <h2>{academicEventEdit ? "Edit academic event" : "Add a holiday or no-class day"}</h2>
            <label className="field">Title<input value={academicEvent.title} onChange={(event) => setAcademicEvent((current) => ({ ...current, title: event.target.value }))} placeholder="Fall break" /></label>
            <div className="form-grid">
              <label className="field">Starts<input type="date" value={academicEvent.startsOn} onChange={(event) => setAcademicEvent((current) => ({ ...current, startsOn: event.target.value, endsOn: current.endsOn < event.target.value ? event.target.value : current.endsOn }))} /></label>
              <label className="field">Ends<input type="date" value={academicEvent.endsOn} onChange={(event) => setAcademicEvent((current) => ({ ...current, endsOn: event.target.value }))} /></label>
            </div>
            <label className="setting-toggle compact"><input type="checkbox" checked={academicEvent.noClass} onChange={(event) => setAcademicEvent((current) => ({ ...current, noClass: event.target.checked }))} /><span><strong>No classes or schedulable work</strong><small>Coqui treats this as protected capacity.</small></span></label>
            <div className="modal-actions">
              {academicEventEdit && <button className="outline" onClick={() => { setAcademicEventEdit(null); setAcademicEvent(emptyAcademicEvent); }}>Cancel</button>}
              <button className="solid" disabled={busy || !academicEvent.title.trim()} onClick={() => { const input = { ...academicEvent, termId: workspace.terms.find((value) => value.active)?.id }; void act(() => academicEventEdit ? updateAcademicEvent(academicEventEdit.id, { ...input, expectedVersion: academicEventEdit.version }) : createAcademicEvent(input)).then(() => { setAcademicEventEdit(null); setAcademicEvent(emptyAcademicEvent); }); }}>{academicEventEdit ? "Save academic event" : "Add academic event"}</button>
            </div>
          </section>
        </div>
      ) : (
        <>
          <div className={`workspace-grid academics ${mode}`}>
            {mode === "courses" && (
            <section className="workspace-panel">
              <div className="section-head">
                <h2>Courses</h2>
                <span>{workspace.courses.length}</span>
              </div>
              {workspace.courses.length ? (
                <div className="record-list compact">
                  {workspace.courses.map((item) => (
                    <article className={selectedCourseId===item.id?"selected-record":""} key={item.id}>
                      <div className="record-icon course">
                        <BookOpen />
                      </div>
                      <div>
                        <strong>{item.code || item.title}</strong>
                        <small>{item.title}</small>
                        {workspace.instructors.filter((instructor) => instructor.courseId === item.id).map((instructor) => (
                          <small key={instructor.id}>
                            Instructor · {instructor.name}{instructor.email ? ` · ${instructor.email}` : ""}
                            <button className="text-button" onClick={() => { setInstructorEdit(instructor); setInstructorDraft({ courseId: instructor.courseId, name: instructor.name, email: instructor.email, officeLocation: instructor.officeLocation, officeHours: instructor.officeHours }); }}>Edit</button>
                            <button className="text-button danger" disabled={busy} onClick={() => { if (window.confirm(`Remove ${instructor.name} from ${item.code || item.title}?`)) void act(() => deleteInstructor(instructor.id, instructor.version)); }}>Remove</button>
                          </small>
                        ))}
                        {workspace.classMeetings.filter((meeting) => meeting.courseId === item.id).map((meeting) => (
                          <small key={meeting.id}>
                            {meeting.weekdays.map((day) => weekdays[day].slice(0, 3)).join("/")} · {meeting.startsAtLocal}–{meeting.endsAtLocal} · {meeting.component}
                            <button className="text-button" onClick={() => { setMeetingEdit(meeting); setMeetingDraft({ courseId: meeting.courseId, weekdays: meeting.weekdays, startsAtLocal: meeting.startsAtLocal, endsAtLocal: meeting.endsAtLocal, component: meeting.component, location: meeting.location, modality:meeting.modality }); }}>Edit</button>
                            <button className="text-button danger" disabled={busy} onClick={() => { if (window.confirm(`Remove this ${meeting.component} time from ${item.code || item.title}?`)) void act(() => deleteClassMeeting(meeting.id, meeting.version)); }}>Remove</button>
                          </small>
                        ))}
                      </div>
                      <div className="record-actions">
                        <button className="outline" aria-pressed={selectedCourseId===item.id} onClick={()=>{setSelectedCourseId(item.id);setCourseTab("overview");}}>Open</button>
                        <button
                          className="outline"
                          onClick={() => editCourse(item)}
                        >
                          Edit
                        </button>
                        <button
                          className="text-button danger"
                          disabled={busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete ${item.title}? Tasks will be kept without a course.`,
                              )
                            )
                              void act(() =>
                                deleteCourse(item.id, item.version),
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
                  <BookOpen />
                  <strong>No courses yet</strong>
                  <p>Add a course manually or approve one from an import.</p>
                </div>
              )}
              {selectedCourseId && workspace.courses.some((item)=>item.id===selectedCourseId) && <section className="course-workspace" aria-label={`${courseNameFor(workspace.courses,selectedCourseId)} workspace`}><div className="section-head"><h3>{courseNameFor(workspace.courses,selectedCourseId)}</h3><span>Course workspace</span></div><div className="segmented course-tabs" role="tablist">{(["overview","work","schedule","materials","grades"] as const).map((value)=><button role="tab" aria-selected={courseTab===value} className={courseTab===value?"active":""} key={value} onClick={()=>setCourseTab(value)}>{value[0].toUpperCase()+value.slice(1)}</button>)}</div>
                {courseTab==="overview"&&<div className="course-overview"><p>{workspace.courses.find((item)=>item.id===selectedCourseId)?.title}</p>{workspace.instructors.filter((item)=>item.courseId===selectedCourseId).map((item)=><p key={item.id}><strong>{item.name}</strong>{item.email?` · ${item.email}`:""}</p>)}</div>}
                {courseTab==="work"&&<div className="record-list compact">{workspace.tasks.filter((item)=>item.courseId===selectedCourseId).map((item)=><article key={item.id}><ListChecks/><span><strong>{item.title}</strong><small>{item.dueAt?`Due ${formatDateTime(item.dueAt)}`:"No due date"}</small></span></article>)}</div>}
                {courseTab==="schedule"&&<div className="record-list compact">{workspace.classMeetings.filter((item)=>item.courseId===selectedCourseId).map((item)=><article key={item.id}><CalendarDays/><span><strong>{item.component}</strong><small>{item.weekdays.map((day)=>weekdays[day].slice(0,3)).join("/")} · {item.startsAtLocal}–{item.endsAtLocal} · {item.location||"No location"}{item.modality?` · ${item.modality.replaceAll("_"," ")}`:""}</small></span></article>)}</div>}
                {courseTab==="materials"&&<div className="course-section"><div className="section-head subhead"><div><h3>Course materials</h3><p>Encrypted sources currently assigned to this course.</p></div><button className="outline" onClick={onStudy}>Manage in Study</button></div>{studyWorkspace?.materials.some((item)=>item.courseIds.includes(selectedCourseId))?<div className="record-list compact">{studyWorkspace.materials.filter((item)=>item.courseIds.includes(selectedCourseId)).map((item)=><article key={item.id}><HardDrive/><span><strong>{item.fileName}</strong><small>{item.segmentCount} cited section{item.segmentCount===1?"":"s"} · {item.mime}</small></span></article>)}</div>:<div className="empty-state"><Brain/><strong>No course materials yet</strong><p>Assign encrypted documents to this course in Study.</p><button className="solid" onClick={onStudy}>Add course materials</button></div>}</div>}
                {courseTab==="grades"&&<div className="course-section"><div className="section-head subhead"><div><h3>Grades and forecast</h3><p>A course-level view of locally entered scores.</p></div><button className="outline" onClick={onStudy}>Edit in Study</button></div>{(()=>{const grade=studyWorkspace?.courseGrades.find((item)=>item.courseId===selectedCourseId);const items=studyWorkspace?.gradeItems.filter((item)=>item.courseId===selectedCourseId)??[];return grade||items.length?<><div className="grade-summary"><article><span>Current</span><strong>{grade?.currentPercent!==undefined?`${grade.currentPercent.toFixed(1)}%`:"—"}</strong></article><article><span>Projected letter</span><strong>{grade?.projectedLetter??"Add scale"}</strong></article><article><span>Missing-work impact</span><strong>{grade?`${grade.missingWorkImpact.toFixed(1)} pts`:"—"}</strong></article></div><div className="grade-list">{items.map((item)=><article key={item.id}><span><strong>{item.title}</strong><small>{item.status}</small></span><b>{item.score??0}/{item.pointsPossible}</b></article>)}</div></>:<div className="empty-state"><Brain/><strong>No grades yet</strong><p>Add categories, scores, and a grading scale in Study to see forecasts here.</p><button className="solid" onClick={onStudy}>Set up grades</button></div>;})()}</div>}
              </section>}
              <div className="inline-editor">
                <h3>{courseEdit ? "Edit course" : "Add a course"}</h3>
                <div className="form-grid">
                  <label className="field">
                    Course name
                    <input
                      value={course.title}
                      onChange={(event) =>
                        setCourse((current) => ({
                          ...current,
                          title: event.target.value,
                        }))
                      }
                      placeholder="English Composition"
                    />
                  </label>
                  <label className="field">
                    Code
                    <input
                      value={course.code}
                      onChange={(event) => {
                        const code = event.target.value;
                        setCourse((current) => ({ ...current, code }));
                        const institutionId = workspace?.institution?.id ?? "";
                        if (!code.trim() || !institutionId) {
                          setCourseSuggestions([]);
                          return;
                        }
                        searchCourseSuggestions(institutionId, code)
                          .then(setCourseSuggestions)
                          .catch(() => setCourseSuggestions([]));
                      }}
                      placeholder="ENG 102"
                    />
                  </label>
                </div>
                {courseSuggestions.length > 0 && (
                  <div className="course-suggestions">
                    {courseSuggestions.map((suggestion) => (
                      <button
                        key={`${suggestion.source}-${suggestion.code}`}
                        onClick={() => {
                          setCourse({ code: suggestion.code, title: suggestion.title });
                          setCourseSuggestions([]);
                        }}
                      >
                        <span>
                          <strong>
                            {suggestion.code} · {suggestion.title}
                          </strong>
                          <small>
                            {suggestion.sections?.length
                              ? `${suggestion.sourceLabel}${suggestion.termLabel ? ` · ${suggestion.termLabel}` : ""} · add class times from Timetable`
                              : suggestion.sourceLabel}
                          </small>
                        </span>
                        <em>{Math.round(suggestion.confidence * 100)}%</em>
                      </button>
                    ))}
                  </div>
                )}
                <div className="modal-actions">
                  {courseEdit && (
                    <button
                      className="outline"
                      onClick={() => {
                        setCourseEdit(null);
                        setCourse({ title: "", code: "" });
                        setCourseSuggestions([]);
                      }}
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    className="solid"
                    disabled={busy || !course.title.trim()}
                    onClick={() =>
                      void act(() =>
                        courseEdit
                          ? updateCourse(courseEdit.id, course)
                          : createCourse(course),
                      ).then(() => {
                        setCourseEdit(null);
                        setCourse({ title: "", code: "" });
                        setCourseSuggestions([]);
                      })
                    }
                  >
                    {courseEdit ? "Save course" : "Add course"}
                  </button>
                </div>
              </div>
              {workspace.courses.length > 0 && <div className="course-detail-editors">
                <div className="inline-editor">
                  <h3>{instructorEdit ? "Edit instructor" : "Add an instructor"}</h3>
                  <div className="form-grid"><label className="field">Course<select value={instructorDraft.courseId || workspace.courses[0].id} onChange={(event) => setInstructorDraft((current) => ({ ...current, courseId: event.target.value }))}>{workspace.courses.map((item) => <option value={item.id} key={item.id}>{item.code || item.title}</option>)}</select></label><label className="field">Name<input value={instructorDraft.name} onChange={(event) => setInstructorDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Professor name" /></label><label className="field">Email (optional)<input type="email" value={instructorDraft.email} onChange={(event) => setInstructorDraft((current) => ({ ...current, email: event.target.value }))} /></label><label className="field">Office (optional)<input value={instructorDraft.officeLocation} onChange={(event) => setInstructorDraft((current) => ({ ...current, officeLocation: event.target.value }))} /></label></div>
                  <div className="modal-actions">
                    {instructorEdit && <button className="outline" onClick={() => { setInstructorEdit(null); setInstructorDraft(emptyInstructor); }}>Cancel</button>}
                    <button className="solid" disabled={busy || !instructorDraft.name.trim()} onClick={() => { const input = { ...instructorDraft, courseId: instructorDraft.courseId || workspace.courses[0].id }; void act(() => instructorEdit ? updateInstructor(instructorEdit.id, { ...input, expectedVersion: instructorEdit.version }) : createInstructor(input)).then(() => { setInstructorEdit(null); setInstructorDraft(emptyInstructor); }); }}>{instructorEdit ? "Save instructor" : "Add instructor"}</button>
                  </div>
                </div>
                <div className="inline-editor">
                  <h3>{meetingEdit ? "Edit class time" : "Add a recurring class time"}</h3>
                  <label className="field">Course<select value={meetingDraft.courseId || workspace.courses[0].id} onChange={(event) => setMeetingDraft((current) => ({ ...current, courseId: event.target.value }))}>{workspace.courses.map((item) => <option value={item.id} key={item.id}>{item.code || item.title}</option>)}</select></label>
                  <div className="day-chips">{weekdays.map((day, dayIndex) => <button className={meetingDraft.weekdays.includes(dayIndex) ? "active" : ""} key={day} onClick={() => setMeetingDraft((current) => ({ ...current, weekdays: current.weekdays.includes(dayIndex) ? current.weekdays.filter((value) => value !== dayIndex) : [...current.weekdays, dayIndex].sort() }))}>{day.slice(0, 3)}</button>)}</div>
                  <div className="form-grid"><label className="field">Starts<input type="time" value={meetingDraft.startsAtLocal} onChange={(event) => setMeetingDraft((current) => ({ ...current, startsAtLocal: event.target.value }))} /></label><label className="field">Ends<input type="time" value={meetingDraft.endsAtLocal} onChange={(event) => setMeetingDraft((current) => ({ ...current, endsAtLocal: event.target.value }))} /></label><label className="field">Type<select value={meetingDraft.component} onChange={(event) => setMeetingDraft((current) => ({ ...current, component: event.target.value }))}><option value="lecture">Lecture</option><option value="lab">Lab</option><option value="seminar">Seminar</option></select></label><label className="field">Location<input value={meetingDraft.location} onChange={(event) => setMeetingDraft((current) => ({ ...current, location: event.target.value }))} /></label><label className="field">Modality<select value={meetingDraft.modality} onChange={(event)=>setMeetingDraft((current)=>({...current,modality:event.target.value}))}><option value="">Not specified</option><option value="in_person">In person</option><option value="online">Online</option><option value="hybrid">Hybrid</option></select></label></div>
                  <div className="modal-actions">
                    {meetingEdit && <button className="outline" onClick={() => { setMeetingEdit(null); setMeetingDraft(emptyMeeting); }}>Cancel</button>}
                    <button className="solid" disabled={busy || meetingDraft.weekdays.length === 0} onClick={() => { const courseId = meetingDraft.courseId || workspace.courses[0].id; const termId = workspace.courses.find((item) => item.id === courseId)?.termId || workspace.terms.find((value) => value.active)?.id; if (!termId || !workspace.profile) return; const input = { ...meetingDraft, courseId, termId, timezone: workspace.profile.timezone }; void act(() => meetingEdit ? updateClassMeeting(meetingEdit.id, { ...input, expectedVersion: meetingEdit.version }) : createClassMeeting(input)).then(() => { setMeetingEdit(null); setMeetingDraft(emptyMeeting); }); }}>{meetingEdit ? "Save class time" : "Add class time"}</button>
                  </div>
                </div>
              </div>}
            </section>
            )}
            {mode === "assignments" && (
            <section className="workspace-panel">
              <div className="section-head">
                <h2>Assignments & exams</h2>
                <span>
                  {workspace.tasks.filter((item) => !item.completed).length}{" "}
                  open
                </span>
              </div>
              <div className="segmented work-tabs" role="tablist" aria-label="Work filters">
                {(["inbox","upcoming","overdue","exams","completed"] as const).map((filter)=><button role="tab" aria-selected={workFilter===filter} className={workFilter===filter?"active":""} key={filter} onClick={()=>setWorkFilter(filter)}>{filter[0].toUpperCase()+filter.slice(1)}</button>)}
              </div>
              {workspace.tasks.length ? (
                <div className="record-list compact">
                  {workspace.tasks.filter((item)=>{
                    const overdue=Boolean(item.dueAt)&&new Date(item.dueAt!).getTime()<Date.now()&&!item.completed;
                    if(workFilter==="completed")return item.completed;
                    if(workFilter==="exams")return item.kind==="exam"&&!item.completed;
                    if(workFilter==="overdue")return overdue;
                    if(workFilter==="inbox")return !item.completed&&!item.dueAt;
                    return !item.completed&&!overdue;
                  }).map((item) => (
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
                          {item.kind === "exam" ? "Exam" : item.kind === "assignment" ? "Assignment" : "Task"} · {item.minutes} min · Priority {item.priority}
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
                        <button
                          className="outline"
                          onClick={() => editTask(item)}
                        >
                          Edit
                        </button>
                        <button
                          className="text-button danger"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(`Delete ${item.title}?`))
                              void act(() =>
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
                  <strong>No tasks yet</strong>
                  <p>
                    Add your first task or import a syllabus to create
                    reviewable deadlines.
                  </p>
                </div>
              )}
            </section>
            )}
          </div>
          {mode === "assignments" && (
          <section className="workspace-panel task-editor">
            <h2>{taskEdit ? `Edit ${task.kind}` : "Add an assignment or exam"}</h2>
            <div className="form-grid compact">
              <label className="field full">
                Task
                <input
                  value={task.title}
                  onChange={(event) =>
                    setTask((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
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
                  value={localValue(task.dueAt)}
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
              <p className="field-help">Coqui chooses the do date from these constraints. The due date above never changes.</p>
              <div className="form-grid">
              <label className="field">
                Earliest start
                <input
                  type="datetime-local"
                  value={localValue(task.earliestStart)}
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
                      energyDemand: event.target
                        .value as TaskInput["energyDemand"],
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
                  Student Center will still respect the minimum and maximum
                  session lengths.
                </small>
              </span>
            </label>
            <fieldset className="dependency-picker">
              <legend>Prerequisites</legend>
              {workspace.tasks.filter((item) => item.id !== taskEdit?.id)
                .length ? (
                workspace.tasks
                  .filter((item) => item.id !== taskEdit?.id)
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
              {taskEdit && (
                <button
                  className="outline"
                  onClick={() => {
                    setTaskEdit(null);
                    setTask(emptyTask);
                  }}
                >
                  Cancel
                </button>
              )}
              <button
                className="solid"
                disabled={busy || !task.title.trim()}
                onClick={() =>
                  void act(() =>
                    taskEdit
                      ? updateLocalTask(taskEdit.id, task)
                      : createLocalTask(task),
                  ).then(() => {
                    setTaskEdit(null);
                    setTask(emptyTask);
                  })
                }
              >
                {taskEdit ? "Save task" : "Add task and replan"}
              </button>
            </div>
          </section>
          )}
          {mode === "settings" && (
          <>
          <section className="workspace-panel preference-editor">
            <div className="section-head">
              <h2>Academic terms</h2>
              <span>{workspace.terms.length}</span>
            </div>
            {workspace.terms.length ? (
              <div className="record-list compact">
                {workspace.terms.map((item) => (
                  <article key={item.id}>
                    <div className="record-icon course">
                      <CalendarDays />
                    </div>
                    <div>
                      <strong>
                        {item.name}
                        {item.active ? " · Active" : ""}
                      </strong>
                      <small>
                        {item.startsOn} – {item.endsOn}
                      </small>
                    </div>
                    <div className="record-actions">
                      <button
                        className="outline"
                        onClick={() => {
                          setTermEdit(item);
                          setTerm({
                            name: item.name,
                            startsOn: item.startsOn,
                            endsOn: item.endsOn,
                            active: item.active,
                            expectedVersion: item.version,
                          });
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="text-button danger"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete ${item.name}? Courses and class times in this term are removed with it.`,
                            )
                          )
                            void act(() => deleteAcademicTerm(item.id, item.version));
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
                <strong>No terms yet</strong>
                <p>Add the term your courses belong to.</p>
              </div>
            )}
            <div className="inline-editor">
              <h3>{termEdit ? "Edit term" : "Add a term"}</h3>
              <div className="form-grid">
                <label className="field">
                  Term name
                  <input
                    value={term.name}
                    onChange={(event) =>
                      setTerm((current) => ({ ...current, name: event.target.value }))
                    }
                    placeholder="Fall 2026"
                  />
                </label>
                <label className="field">
                  Starts
                  <input
                    type="date"
                    value={term.startsOn}
                    onChange={(event) =>
                      setTerm((current) => ({ ...current, startsOn: event.target.value }))
                    }
                  />
                </label>
                <label className="field">
                  Ends
                  <input
                    type="date"
                    value={term.endsOn}
                    onChange={(event) =>
                      setTerm((current) => ({ ...current, endsOn: event.target.value }))
                    }
                  />
                </label>
                <label className="setting-toggle compact">
                  <input
                    type="checkbox"
                    checked={term.active}
                    onChange={(event) =>
                      setTerm((current) => ({ ...current, active: event.target.checked }))
                    }
                  />
                  <span>Current term</span>
                </label>
              </div>
              <div className="modal-actions">
                {termEdit && (
                  <button
                    className="outline"
                    onClick={() => {
                      setTermEdit(null);
                      setTerm(emptyTerm);
                    }}
                  >
                    Cancel
                  </button>
                )}
                <button
                  className="solid"
                  disabled={
                    busy || !term.name.trim() || !term.startsOn || !term.endsOn
                  }
                  onClick={() =>
                    void act(() =>
                      termEdit
                        ? updateAcademicTerm(termEdit.id, term)
                        : createAcademicTerm(term),
                    ).then(() => {
                      setTermEdit(null);
                      setTerm(emptyTerm);
                    })
                  }
                >
                  {termEdit ? "Save term" : "Add term"}
                </button>
              </div>
            </div>
          </section>
          <section className="workspace-panel preference-editor">
            <h2>Local profile</h2>
            <div className="form-grid compact">
              <label className="field">
                Name
                <input
                  value={profileEditor.name}
                  onChange={(event) =>
                    setProfileEditor((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="field">
                IANA timezone
                <input
                  value={profileEditor.timezone}
                  onChange={(event) =>
                    setProfileEditor((current) => ({
                      ...current,
                      timezone: event.target.value,
                    }))
                  }
                  placeholder="America/Phoenix"
                />
              </label>
            </div>
            <div className="modal-actions">
              <button
                className="solid"
                disabled={
                  busy ||
                  !profileEditor.name.trim() ||
                  !profileEditor.timezone.trim()
                }
                onClick={() =>
                  void act(() => updateStudentProfile(profileEditor))
                }
              >
                Save profile and replan
              </button>
            </div>
          </section>
          {preferences && (
            <section className="workspace-panel preference-editor">
              <h2>Planning preferences</h2>
              <div className="form-grid compact">
                <label className="field">
                  Sleep begins
                  <input
                    type="time"
                    value={preferences.sleepStart}
                    onChange={(event) =>
                      setPreferences((current) =>
                        current
                          ? { ...current, sleepStart: event.target.value }
                          : current,
                      )
                    }
                  />
                </label>
                <label className="field">
                  Sleep ends
                  <input
                    type="time"
                    value={preferences.sleepEnd}
                    onChange={(event) =>
                      setPreferences((current) =>
                        current
                          ? { ...current, sleepEnd: event.target.value }
                          : current,
                      )
                    }
                  />
                </label>
                <label className="field">
                  Max session
                  <input
                    type="number"
                    min="15"
                    max="240"
                    step="5"
                    value={preferences.maxSessionMinutes}
                    onChange={(event) =>
                      setPreferences((current) =>
                        current
                          ? {
                              ...current,
                              maxSessionMinutes: Number(event.target.value),
                            }
                          : current,
                      )
                    }
                  />
                </label>
                <label className="field">
                  Break minutes
                  <input
                    type="number"
                    min="0"
                    max="60"
                    step="5"
                    value={preferences.breakMinutes}
                    onChange={(event) =>
                      setPreferences((current) =>
                        current
                          ? {
                              ...current,
                              breakMinutes: Number(event.target.value),
                            }
                          : current,
                      )
                    }
                  />
                </label>
                <label className="field">
                  Transition minutes
                  <input
                    type="number"
                    min="0"
                    max="120"
                    step="5"
                    value={preferences.transitionMinutes}
                    onChange={(event) =>
                      setPreferences((current) =>
                        current
                          ? {
                              ...current,
                              transitionMinutes: Number(event.target.value),
                            }
                          : current,
                      )
                    }
                  />
                </label>
                <label className="field">
                  Default commute
                  <input
                    type="number"
                    min="0"
                    max="240"
                    step="5"
                    value={preferences.defaultCommuteMinutes}
                    onChange={(event) =>
                      setPreferences((current) =>
                        current
                          ? {
                              ...current,
                              defaultCommuteMinutes: Number(event.target.value),
                            }
                          : current,
                      )
                    }
                  />
                </label>
              </div>
              <fieldset className="availability compact-availability">
                <legend>Weekly availability</legend>
                {weekdays.map((name, weekday) => {
                  const rule = preferences.availability.find(
                    (item) => item.weekday === weekday,
                  );
                  return (
                    <div key={name}>
                      <label>
                        <input
                          type="checkbox"
                          checked={Boolean(rule)}
                          onChange={(event) =>
                            toggleAvailabilityDay(weekday, event.target.checked)
                          }
                        />
                        <span>{name}</span>
                      </label>
                      <input
                        aria-label={`${name} availability starts`}
                        type="time"
                        disabled={!rule}
                        value={rule?.startsAtLocal ?? "08:00"}
                        onChange={(event) =>
                          updateAvailabilityDay(
                            weekday,
                            "startsAtLocal",
                            event.target.value,
                          )
                        }
                      />
                      <span>to</span>
                      <input
                        aria-label={`${name} availability ends`}
                        type="time"
                        disabled={!rule}
                        value={rule?.endsAtLocal ?? "21:00"}
                        onChange={(event) =>
                          updateAvailabilityDay(
                            weekday,
                            "endsAtLocal",
                            event.target.value,
                          )
                        }
                      />
                    </div>
                  );
                })}
              </fieldset>
              <div className="modal-actions">
                <button
                  className="solid"
                  disabled={busy}
                  onClick={() =>
                    void act(() => updatePlanningPreferences(preferences))
                  }
                >
                  Save and replan
                </button>
              </div>
            </section>
          )}
          </>
          )}
        </>
      )}
    </div>
  );
}

const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
