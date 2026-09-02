import { useEffect, useState } from "react";
import {
  BookOpen,
  Brain,
  CalendarDays,
  CircleAlert,
  HardDrive,
  ListChecks,
  X,
} from "lucide-react";
import {
  createClassMeeting,
  createCourse,
  createInstructor,
  deleteClassMeeting,
  deleteCourse,
  deleteInstructor,
  getDashboard,
  getLocalWorkspace,
  getStudyWorkspace,
  searchCourseSuggestions,
  updateClassMeeting,
  updateCourse,
  updateInstructor,
} from "../native";
import type {
  ClassMeetingSeriesRecord,
  CourseInput,
  CourseRecord,
  CourseSuggestion,
  InstructorRecord,
  StudyWorkspace,
  WorkspaceSnapshot,
} from "../native";
import type { WorkspaceRouteProps } from "./workspaceTypes";

type CourseTab = "overview" | "work" | "schedule" | "materials" | "grades";
const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const emptyInstructor = () => ({
  courseId: "",
  name: "",
  email: "",
  officeLocation: "",
  officeHours: "",
});
const emptyMeeting = () => ({
  courseId: "",
  weekdays: [1, 3, 5],
  startsAtLocal: "09:00",
  endsAtLocal: "09:50",
  component: "lecture",
  location: "",
  modality: "",
  rotationIntervalWeeks: 1,
  rotationOffsetWeeks: 0,
});
const formatDateTime = (value?: string) =>
  value
    ? new Intl.DateTimeFormat([], {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "Not set";

export function CoursesView({ onDashboard, onStudy }: WorkspaceRouteProps) {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [study, setStudy] = useState<StudyWorkspace | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [tab, setTab] = useState<CourseTab>("overview");
  const [course, setCourse] = useState<CourseInput>({ title: "", code: "" });
  const [courseEdit, setCourseEdit] = useState<CourseRecord | null>(null);
  const [suggestions, setSuggestions] = useState<CourseSuggestion[]>([]);
  const [instructor, setInstructor] = useState(emptyInstructor);
  const [instructorEdit, setInstructorEdit] = useState<InstructorRecord | null>(
    null,
  );
  const [meeting, setMeeting] = useState(emptyMeeting);
  const [meetingEdit, setMeetingEdit] =
    useState<ClassMeetingSeriesRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void Promise.all([getLocalWorkspace(), getStudyWorkspace()])
      .then(([next, nextStudy]) => {
        if (!active) return;
        setWorkspace(next);
        setStudy(nextStudy);
        setSelectedId(next.courses[0]?.id ?? "");
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, []);

  const act = async (operation: () => Promise<WorkspaceSnapshot>) => {
    setBusy(true);
    setError("");
    try {
      const next = await operation();
      setWorkspace(next);
      setSelectedId((current) =>
        next.courses.some((item) => item.id === current)
          ? current
          : (next.courses[0]?.id ?? ""),
      );
      onDashboard(await getDashboard());
      setStudy(await getStudyWorkspace());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const selected = workspace?.courses.find((item) => item.id === selectedId);
  const editCourse = (value: CourseRecord) => {
    setCourseEdit(value);
    setCourse({
      title: value.title,
      code: value.code,
      termId: value.termId,
      expectedVersion: value.version,
    });
  };
  const resetCourse = () => {
    setCourseEdit(null);
    setCourse({ title: "", code: "" });
    setSuggestions([]);
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
      className="content workspace-page mode-courses"
      data-route="courses"
      aria-label="Courses workspace"
    >
      <div className="page-head">
        <div>
          <p className="eyebrow">Course command center</p>
          <h1>Courses</h1>
          <p>Course details, work, schedule, materials, and grades.</p>
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
      <div className="courses-master-detail">
        <aside className="workspace-panel course-master">
          <div className="section-head">
            <h2>Courses</h2>
            <span>{workspace.courses.length}</span>
          </div>
          {workspace.courses.length ? (
            <div className="course-master-list">
              {workspace.courses.map((item) => (
                <button
                  key={item.id}
                  className={selectedId === item.id ? "active" : ""}
                  aria-pressed={selectedId === item.id}
                  onClick={() => {
                    setSelectedId(item.id);
                    setTab("overview");
                  }}
                >
                  <BookOpen />
                  <span>
                    <strong>{item.code || item.title}</strong>
                    <small>{item.title}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <BookOpen />
              <strong>No courses yet</strong>
              <p>Add a course manually or approve one from an import.</p>
            </div>
          )}
          <CourseEditor
            workspace={workspace}
            course={course}
            edit={courseEdit}
            suggestions={suggestions}
            busy={busy}
            setCourse={setCourse}
            setSuggestions={setSuggestions}
            cancel={resetCourse}
            save={() =>
              void act(() =>
                courseEdit
                  ? updateCourse(courseEdit.id, course)
                  : createCourse(course),
              ).then(resetCourse)
            }
          />
        </aside>
        <div className="workspace-panel course-detail">
          {selected ? (
            <>
              <div className="section-head">
                <div>
                  <p className="eyebrow">Course workspace</p>
                  <h2>{selected.code || selected.title}</h2>
                  <p>{selected.title}</p>
                </div>
                <div className="record-actions">
                  <button
                    className="outline"
                    onClick={() => editCourse(selected)}
                  >
                    Edit course
                  </button>
                  <button
                    className="text-button danger"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete ${selected.title}? Tasks will be kept without a course.`,
                        )
                      )
                        void act(() =>
                          deleteCourse(selected.id, selected.version),
                        );
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div
                className="segmented course-tabs"
                role="tablist"
                aria-label="Course sections"
              >
                {(
                  [
                    "overview",
                    "work",
                    "schedule",
                    "materials",
                    "grades",
                  ] as const
                ).map((value) => (
                  <button
                    role="tab"
                    aria-selected={tab === value}
                    className={tab === value ? "active" : ""}
                    key={value}
                    onClick={() => setTab(value)}
                  >
                    {value[0].toUpperCase() + value.slice(1)}
                  </button>
                ))}
              </div>
              {tab === "overview" && (
                <CourseOverview
                  workspace={workspace}
                  selected={selected}
                  busy={busy}
                  instructor={instructor}
                  instructorEdit={instructorEdit}
                  setInstructor={setInstructor}
                  setInstructorEdit={setInstructorEdit}
                  act={act}
                />
              )}
              {tab === "work" && (
                <div className="record-list compact">
                  {workspace.tasks
                    .filter((item) => item.courseId === selected.id)
                    .map((item) => (
                      <article key={item.id}>
                        <ListChecks />
                        <span>
                          <strong>{item.title}</strong>
                          <small>
                            {item.dueAt
                              ? `Due ${formatDateTime(item.dueAt)}`
                              : "No due date"}
                          </small>
                        </span>
                      </article>
                    ))}
                </div>
              )}
              {tab === "schedule" && (
                <CourseSchedule
                  workspace={workspace}
                  selected={selected}
                  busy={busy}
                  meeting={meeting}
                  meetingEdit={meetingEdit}
                  setMeeting={setMeeting}
                  setMeetingEdit={setMeetingEdit}
                  act={act}
                />
              )}
              {tab === "materials" && (
                <CourseMaterials
                  study={study}
                  courseId={selected.id}
                  onStudy={onStudy}
                />
              )}
              {tab === "grades" && (
                <CourseGrades
                  study={study}
                  courseId={selected.id}
                  onStudy={onStudy}
                />
              )}
            </>
          ) : (
            <div className="empty-state">
              <BookOpen />
              <strong>Select or add a course</strong>
              <p>Its work, schedule, materials, and grades will appear here.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function CourseEditor({
  workspace,
  course,
  edit,
  suggestions,
  busy,
  setCourse,
  setSuggestions,
  cancel,
  save,
}: {
  workspace: WorkspaceSnapshot;
  course: CourseInput;
  edit: CourseRecord | null;
  suggestions: CourseSuggestion[];
  busy: boolean;
  setCourse: React.Dispatch<React.SetStateAction<CourseInput>>;
  setSuggestions: (value: CourseSuggestion[]) => void;
  cancel: () => void;
  save: () => void;
}) {
  return (
    <div className="inline-editor course-master-editor">
      <h3>{edit ? "Edit course" : "Add a course"}</h3>
      <label className="field">
        Course name
        <input
          value={course.title}
          onChange={(event) =>
            setCourse((current) => ({ ...current, title: event.target.value }))
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
            const institutionId = workspace.institution?.id ?? "";
            if (!code.trim() || !institutionId) return setSuggestions([]);
            void searchCourseSuggestions(institutionId, code)
              .then(setSuggestions)
              .catch(() => setSuggestions([]));
          }}
          placeholder="ENG 102"
        />
      </label>
      {suggestions.length > 0 && (
        <div className="course-suggestions">
          {suggestions.map((suggestion) => (
            <button
              key={`${suggestion.source}-${suggestion.code}`}
              onClick={() => {
                setCourse({ code: suggestion.code, title: suggestion.title });
                setSuggestions([]);
              }}
            >
              <span>
                <strong>
                  {suggestion.code} · {suggestion.title}
                </strong>
                <small>
                  {suggestion.sourceLabel}
                  {suggestion.termLabel ? ` · ${suggestion.termLabel}` : ""}
                </small>
              </span>
              <em>{Math.round(suggestion.confidence * 100)}%</em>
            </button>
          ))}
        </div>
      )}
      <div className="modal-actions">
        {edit && (
          <button className="outline" onClick={cancel}>
            Cancel
          </button>
        )}
        <button
          className="solid"
          disabled={busy || !course.title.trim()}
          onClick={save}
        >
          {edit ? "Save course" : "Add course"}
        </button>
      </div>
    </div>
  );
}

function CourseOverview({
  workspace,
  selected,
  busy,
  instructor,
  instructorEdit,
  setInstructor,
  setInstructorEdit,
  act,
}: {
  workspace: WorkspaceSnapshot;
  selected: CourseRecord;
  busy: boolean;
  instructor: ReturnType<typeof emptyInstructor>;
  instructorEdit: InstructorRecord | null;
  setInstructor: React.Dispatch<
    React.SetStateAction<ReturnType<typeof emptyInstructor>>
  >;
  setInstructorEdit: (value: InstructorRecord | null) => void;
  act: (operation: () => Promise<WorkspaceSnapshot>) => Promise<void>;
}) {
  const instructors = workspace.instructors.filter(
    (item) => item.courseId === selected.id,
  );
  const reset = () => {
    setInstructorEdit(null);
    setInstructor(emptyInstructor());
  };
  return (
    <div className="course-overview">
      <section>
        <h3>People</h3>
        {instructors.length ? (
          <div className="record-list compact">
            {instructors.map((item) => (
              <article key={item.id}>
                <div className="record-icon course">
                  <BookOpen />
                </div>
                <div>
                  <strong>{item.name}</strong>
                  <small>
                    {item.email || "No email"}
                    {item.officeLocation ? ` · ${item.officeLocation}` : ""}
                  </small>
                </div>
                <div className="record-actions">
                  <button
                    className="outline"
                    onClick={() => {
                      setInstructorEdit(item);
                      setInstructor({
                        courseId: item.courseId,
                        name: item.name,
                        email: item.email,
                        officeLocation: item.officeLocation,
                        officeHours: item.officeHours,
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
                          `Remove ${item.name} from ${selected.code || selected.title}?`,
                        )
                      )
                        void act(() => deleteInstructor(item.id, item.version));
                    }}
                  >
                    Remove
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="section-empty-copy">No instructor details yet.</p>
        )}
      </section>
      <div className="inline-editor">
        <h3>{instructorEdit ? "Edit instructor" : "Add an instructor"}</h3>
        <div className="form-grid">
          <label className="field">
            Name
            <input
              value={instructor.name}
              onChange={(event) =>
                setInstructor((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
              placeholder="Professor name"
            />
          </label>
          <label className="field">
            Email (optional)
            <input
              type="email"
              value={instructor.email}
              onChange={(event) =>
                setInstructor((current) => ({
                  ...current,
                  email: event.target.value,
                }))
              }
            />
          </label>
          <label className="field">
            Office (optional)
            <input
              value={instructor.officeLocation}
              onChange={(event) =>
                setInstructor((current) => ({
                  ...current,
                  officeLocation: event.target.value,
                }))
              }
            />
          </label>
          <label className="field">
            Office hours
            <input
              value={instructor.officeHours}
              onChange={(event) =>
                setInstructor((current) => ({
                  ...current,
                  officeHours: event.target.value,
                }))
              }
            />
          </label>
        </div>
        <div className="modal-actions">
          {instructorEdit && (
            <button className="outline" onClick={reset}>
              Cancel
            </button>
          )}
          <button
            className="solid"
            disabled={busy || !instructor.name.trim()}
            onClick={() => {
              const input = { ...instructor, courseId: selected.id };
              void act(() =>
                instructorEdit
                  ? updateInstructor(instructorEdit.id, {
                      ...input,
                      expectedVersion: instructorEdit.version,
                    })
                  : createInstructor(input),
              ).then(reset);
            }}
          >
            {instructorEdit ? "Save instructor" : "Add instructor"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CourseSchedule({
  workspace,
  selected,
  busy,
  meeting,
  meetingEdit,
  setMeeting,
  setMeetingEdit,
  act,
}: {
  workspace: WorkspaceSnapshot;
  selected: CourseRecord;
  busy: boolean;
  meeting: ReturnType<typeof emptyMeeting>;
  meetingEdit: ClassMeetingSeriesRecord | null;
  setMeeting: React.Dispatch<
    React.SetStateAction<ReturnType<typeof emptyMeeting>>
  >;
  setMeetingEdit: (value: ClassMeetingSeriesRecord | null) => void;
  act: (operation: () => Promise<WorkspaceSnapshot>) => Promise<void>;
}) {
  const meetings = workspace.classMeetings.filter(
    (item) => item.courseId === selected.id,
  );
  const reset = () => {
    setMeetingEdit(null);
    setMeeting(emptyMeeting());
  };
  return (
    <div className="course-schedule">
      <div className="record-list compact">
        {meetings.map((item) => (
          <article key={item.id}>
            <CalendarDays />
            <span>
              <strong>{item.component}</strong>
              <small>
                {item.weekdays
                  .map((day) => weekdays[day].slice(0, 3))
                  .join("/")}{" "}
                · {item.startsAtLocal}–{item.endsAtLocal} ·{" "}
                {item.location || "No location"}
                {item.modality
                  ? ` · ${item.modality.replaceAll("_", " ")}`
                  : ""}
                {item.rotationIntervalWeeks > 1
                  ? ` · every ${item.rotationIntervalWeeks} weeks`
                  : ""}
              </small>
            </span>
            <div className="record-actions">
              <button
                className="outline"
                onClick={() => {
                  setMeetingEdit(item);
                  setMeeting({
                    courseId: item.courseId,
                    weekdays: item.weekdays,
                    startsAtLocal: item.startsAtLocal,
                    endsAtLocal: item.endsAtLocal,
                    component: item.component,
                    location: item.location,
                    modality: item.modality,
                    rotationIntervalWeeks: item.rotationIntervalWeeks,
                    rotationOffsetWeeks: item.rotationOffsetWeeks,
                  });
                }}
              >
                Edit
              </button>
              <button
                className="text-button danger"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Remove this ${item.component} time?`))
                    void act(() => deleteClassMeeting(item.id, item.version));
                }}
              >
                Remove
              </button>
            </div>
          </article>
        ))}
      </div>
      <div className="inline-editor">
        <h3>
          {meetingEdit ? "Edit class time" : "Add a recurring class time"}
        </h3>
        <div className="day-chips">
          {weekdays.map((day, index) => (
            <button
              className={meeting.weekdays.includes(index) ? "active" : ""}
              key={day}
              onClick={() =>
                setMeeting((current) => ({
                  ...current,
                  weekdays: current.weekdays.includes(index)
                    ? current.weekdays.filter((value) => value !== index)
                    : [...current.weekdays, index].sort(),
                }))
              }
            >
              {day.slice(0, 3)}
            </button>
          ))}
        </div>
        <div className="form-grid">
          <label className="field">
            Starts
            <input
              type="time"
              value={meeting.startsAtLocal}
              onChange={(event) =>
                setMeeting((current) => ({
                  ...current,
                  startsAtLocal: event.target.value,
                }))
              }
            />
          </label>
          <label className="field">
            Ends
            <input
              type="time"
              value={meeting.endsAtLocal}
              onChange={(event) =>
                setMeeting((current) => ({
                  ...current,
                  endsAtLocal: event.target.value,
                }))
              }
            />
          </label>
          <label className="field">
            Type
            <select
              value={meeting.component}
              onChange={(event) =>
                setMeeting((current) => ({
                  ...current,
                  component: event.target.value,
                }))
              }
            >
              <option value="lecture">Lecture</option>
              <option value="lab">Lab</option>
              <option value="seminar">Seminar</option>
            </select>
          </label>
          <label className="field">
            Location
            <input
              value={meeting.location}
              onChange={(event) =>
                setMeeting((current) => ({
                  ...current,
                  location: event.target.value,
                }))
              }
            />
          </label>
          <label className="field">
            Modality
            <select
              value={meeting.modality}
              onChange={(event) =>
                setMeeting((current) => ({
                  ...current,
                  modality: event.target.value,
                }))
              }
            >
              <option value="">Not specified</option>
              <option value="in_person">In person</option>
              <option value="online">Online</option>
              <option value="hybrid">Hybrid</option>
            </select>
          </label>
          <label className="field">
            Repeats
            <select
              value={meeting.rotationIntervalWeeks}
              onChange={(event) =>
                setMeeting((current) => ({
                  ...current,
                  rotationIntervalWeeks: Number(event.target.value),
                  rotationOffsetWeeks: 0,
                }))
              }
            >
              <option value="1">Every week</option>
              <option value="2">Every other week (A/B)</option>
              <option value="3">Every 3 weeks</option>
              <option value="4">Every 4 weeks</option>
            </select>
          </label>
          {meeting.rotationIntervalWeeks > 1 && (
            <label className="field">
              Cycle week
              <select
                value={meeting.rotationOffsetWeeks}
                onChange={(event) =>
                  setMeeting((current) => ({
                    ...current,
                    rotationOffsetWeeks: Number(event.target.value),
                  }))
                }
              >
                {Array.from(
                  { length: meeting.rotationIntervalWeeks },
                  (_, index) => (
                    <option value={index} key={index}>
                      {meeting.rotationIntervalWeeks === 2
                        ? index === 0
                          ? "A week"
                          : "B week"
                        : `Week ${index + 1}`}
                    </option>
                  ),
                )}
              </select>
            </label>
          )}
        </div>
        <div className="modal-actions">
          {meetingEdit && (
            <button className="outline" onClick={reset}>
              Cancel
            </button>
          )}
          <button
            className="solid"
            disabled={busy || meeting.weekdays.length === 0}
            onClick={() => {
              const termId =
                selected.termId ||
                workspace.terms.find((item) => item.active)?.id;
              if (!termId || !workspace.profile) return;
              const input = {
                ...meeting,
                courseId: selected.id,
                termId,
                timezone: workspace.profile.timezone,
              };
              void act(() =>
                meetingEdit
                  ? updateClassMeeting(meetingEdit.id, {
                      ...input,
                      expectedVersion: meetingEdit.version,
                    })
                  : createClassMeeting(input),
              ).then(reset);
            }}
          >
            {meetingEdit ? "Save class time" : "Add class time"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CourseMaterials({
  study,
  courseId,
  onStudy,
}: {
  study: StudyWorkspace | null;
  courseId: string;
  onStudy: () => void;
}) {
  const materials =
    study?.materials.filter((item) => item.courseIds.includes(courseId)) ?? [];
  return (
    <div className="course-section">
      <div className="section-head subhead">
        <div>
          <h3>Course materials</h3>
          <p>Encrypted sources assigned to this course.</p>
        </div>
        <button className="outline" onClick={onStudy}>
          Manage in Study
        </button>
      </div>
      {materials.length ? (
        <div className="record-list compact">
          {materials.map((item) => (
            <article key={item.id}>
              <HardDrive />
              <span>
                <strong>{item.fileName}</strong>
                <small>
                  {item.segmentCount} cited section
                  {item.segmentCount === 1 ? "" : "s"} · {item.mime}
                </small>
              </span>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <Brain />
          <strong>No course materials yet</strong>
          <p>Assign encrypted documents to this course in Study.</p>
          <button className="solid" onClick={onStudy}>
            Add course materials
          </button>
        </div>
      )}
    </div>
  );
}

function CourseGrades({
  study,
  courseId,
  onStudy,
}: {
  study: StudyWorkspace | null;
  courseId: string;
  onStudy: () => void;
}) {
  const grade = study?.courseGrades.find((item) => item.courseId === courseId);
  const items =
    study?.gradeItems.filter((item) => item.courseId === courseId) ?? [];
  return (
    <div className="course-section">
      <div className="section-head subhead">
        <div>
          <h3>Grades and forecast</h3>
          <p>A course-level view of locally entered scores.</p>
        </div>
        <button className="outline" onClick={onStudy}>
          Edit in Study
        </button>
      </div>
      {grade || items.length ? (
        <>
          <div className="grade-summary">
            <article>
              <span>Current</span>
              <strong>
                {grade?.currentPercent !== undefined
                  ? `${grade.currentPercent.toFixed(1)}%`
                  : "—"}
              </strong>
            </article>
            <article>
              <span>Projected letter</span>
              <strong>{grade?.projectedLetter ?? "Add scale"}</strong>
            </article>
            <article>
              <span>Missing-work impact</span>
              <strong>
                {grade ? `${grade.missingWorkImpact.toFixed(1)} pts` : "—"}
              </strong>
            </article>
          </div>
          <div className="grade-list">
            {items.map((item) => (
              <article key={item.id}>
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.status}</small>
                </span>
                <b>
                  {item.score ?? 0}/{item.pointsPossible}
                </b>
              </article>
            ))}
          </div>
        </>
      ) : (
        <div className="empty-state">
          <Brain />
          <strong>No grades yet</strong>
          <p>
            Add categories, scores, and a grading scale in Study to see
            forecasts here.
          </p>
          <button className="solid" onClick={onStudy}>
            Set up grades
          </button>
        </div>
      )}
    </div>
  );
}
