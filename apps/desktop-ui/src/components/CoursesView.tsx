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

import {
  emptyInstructor,
  emptyMeeting,
  type CourseTab,
} from "../features/courses/courseModel";
import { CourseEditor } from "../features/courses/CourseEditor";
import { CourseOverview } from "../features/courses/CourseOverview";
import { CourseSchedule } from "../features/courses/CourseSchedule";
import { CourseMaterials } from "../features/courses/CourseMaterials";
import { CourseGrades } from "../features/courses/CourseGrades";
import { Modal } from "./Modal";
import { useTaskDetailsSession } from "../features/tasks/TaskDetailsSession";
import "../features/courses/courses.css";
const formatDateTime = (value?: string) =>
  value
    ? new Intl.DateTimeFormat([], {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "Not set";

export function CoursesView({
  onDashboard,
  onStudy,
  onImport,
  onOpenTask,
  onOpenStudy,
}: WorkspaceRouteProps & {
  onOpenTask?: (id: string) => void;
  onOpenStudy?: (courseId: string, section: "materials" | "grades") => void;
}) {
  const session = useTaskDetailsSession().courses;
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [study, setStudy] = useState<StudyWorkspace | null>(null);
  const [selectedId, setSelectedId] = useState(session.selectedId);
  const [tab, setTab] = useState<CourseTab>(session.tab);
  const [course, setCourse] = useState<CourseInput>(session.course);
  const [courseEdit, setCourseEdit] = useState<CourseRecord | null>(
    session.courseEdit,
  );
  const [editorOpen, setEditorOpen] = useState(session.editorOpen);
  const [suggestions, setSuggestions] = useState<CourseSuggestion[]>([]);
  const [instructor, setInstructor] = useState(
    () => session.people.get(session.selectedId)?.form ?? emptyInstructor(),
  );
  const [instructorEdit, setInstructorEdit] = useState<InstructorRecord | null>(
    session.people.get(session.selectedId)?.edit ?? null,
  );
  const [meeting, setMeeting] = useState(
    () => session.schedules.get(session.selectedId)?.form ?? emptyMeeting(),
  );
  const [meetingEdit, setMeetingEdit] =
    useState<ClassMeetingSeriesRecord | null>(
      session.schedules.get(session.selectedId)?.edit ?? null,
    );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState("");
  const [studyError, setStudyError] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    Object.assign(session, { selectedId, tab, course, courseEdit, editorOpen });
    if (selectedId) {
      session.people.set(selectedId, {
        form: instructor,
        edit: instructorEdit,
      });
      session.schedules.set(selectedId, { form: meeting, edit: meetingEdit });
    }
  }, [
    session,
    selectedId,
    tab,
    course,
    courseEdit,
    editorOpen,
    instructor,
    instructorEdit,
    meeting,
    meetingEdit,
  ]);
  const selectCourse = (id: string) => {
    setSelectedId(id);
    setInstructor(session.people.get(id)?.form ?? emptyInstructor());
    setInstructorEdit(session.people.get(id)?.edit ?? null);
    setMeeting(session.schedules.get(id)?.form ?? emptyMeeting());
    setMeetingEdit(session.schedules.get(id)?.edit ?? null);
  };

  useEffect(() => {
    let active = true;
    setError("");
    void getLocalWorkspace()
      .then((next) => {
        if (!active) return;
        setWorkspace(next);
        selectCourse(
          next.courses.some((item) => item.id === session.selectedId)
            ? session.selectedId
            : (next.courses[0]?.id ?? ""),
        );
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    void getStudyWorkspace()
      .then((value) => {
        if (active) {
          setStudy(value);
          setStudyError("");
        }
      })
      .catch((reason) => {
        if (active) setStudyError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [reload]);

  const act = async (operation: () => Promise<WorkspaceSnapshot>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await operation();
      setWorkspace(next);
      if (!next.courses.some((item) => item.id === selectedId))
        selectCourse(next.courses[0]?.id ?? "");
      setNotice("Saved locally.");
      try {
        onDashboard(await getDashboard());
        setStudy(await getStudyWorkspace());
      } catch {
        setNotice(
          "Saved locally, but linked views could not refresh. Reopen this workspace to reload them.",
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

  const selected = workspace?.courses.find((item) => item.id === selectedId);
  const editCourse = (value: CourseRecord) => {
    setEditorOpen(true);
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
          {error ? (
            <>
              <p role="alert">{error}</p>
              <button
                className="outline"
                onClick={() => setReload((value) => value + 1)}
              >
                Retry Courses
              </button>
            </>
          ) : (
            <strong role="status">Loading your encrypted local records…</strong>
          )}
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
          <h1>Courses</h1>
          <p>Course details, work, schedule, materials, and grades.</p>
        </div>
        <div className="page-head-actions">
          <button className="outline" onClick={onImport}>
            Import courses
          </button>
          <button
            className="solid"
            onClick={() => {
              resetCourse();
              setEditorOpen(true);
            }}
          >
            New course
          </button>
        </div>
      </div>
      {error && !editorOpen && (
        <div className="alert" role="alert">
          <CircleAlert />
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <X />
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="field-help">
          {notice}
        </p>
      )}
      <div className="courses-master-detail">
        <aside className="workspace-panel course-master">
          <div className="section-head">
            <h2>Courses</h2>
            <span>{workspace.courses.length}</span>
          </div>
          <label className="field course-search">
            Find a course
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name or code"
            />
          </label>
          {workspace.courses.length ? (
            <div className="course-master-list">
              {workspace.courses
                .filter((item) =>
                  `${item.code} ${item.title}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((item) => (
                  <button
                    key={item.id}
                    className={selectedId === item.id ? "active" : ""}
                    aria-pressed={selectedId === item.id}
                    disabled={busy}
                    onClick={() => {
                      selectCourse(item.id);
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
        </aside>
        {editorOpen && (
          <Modal
            title={courseEdit ? "Edit course" : "New course"}
            subtitle="Course details are stored on this device."
            close={() => {
              if (!busy) setEditorOpen(false);
            }}
          >
            {error && <p role="alert">{error}</p>}
            <CourseEditor
              workspace={workspace}
              course={course}
              edit={courseEdit}
              suggestions={suggestions}
              busy={busy}
              setCourse={setCourse}
              setSuggestions={setSuggestions}
              cancel={() => {
                resetCourse();
                setEditorOpen(false);
              }}
              save={() =>
                void act(() =>
                  courseEdit
                    ? updateCourse(courseEdit.id, course)
                    : createCourse(course),
                ).then((saved) => {
                  if (saved) {
                    resetCourse();
                    setEditorOpen(false);
                  }
                })
              }
            />
          </Modal>
        )}
        <div className="workspace-panel course-detail">
          {selected ? (
            <>
              <div className="section-head">
                <div>
                  <h2>{selected.code || selected.title}</h2>
                  <p>{selected.title}</p>
                </div>
                <div className="record-actions">
                  <button
                    className="outline"
                    disabled={busy}
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
                  {!workspace.tasks.some(
                    (item) => item.courseId === selected.id,
                  ) && (
                    <p className="section-empty-copy">
                      No work assigned to this course. Create a task in Work or
                      review an import.
                    </p>
                  )}
                  {workspace.tasks
                    .filter((item) => item.courseId === selected.id)
                    .map((item) => (
                      <article key={item.id}>
                        <ListChecks />
                        <span>
                          {onOpenTask ? (
                            <button
                              className="course-task-link"
                              onClick={() => onOpenTask(item.id)}
                            >
                              {item.title}
                            </button>
                          ) : (
                            <strong>{item.title}</strong>
                          )}
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
              {(tab === "materials" || tab === "grades") && studyError && (
                <p role="alert">
                  Study records could not load. {studyError}
                  <button
                    className="outline"
                    onClick={() => setReload((value) => value + 1)}
                  >
                    Retry linked records
                  </button>
                </p>
              )}
              {tab === "materials" && !studyError && (
                <CourseMaterials
                  study={study}
                  courseId={selected.id}
                  onStudy={() =>
                    onOpenStudy
                      ? onOpenStudy(selected.id, "materials")
                      : onStudy()
                  }
                />
              )}
              {tab === "grades" && !studyError && (
                <CourseGrades
                  study={study}
                  courseId={selected.id}
                  onStudy={() =>
                    onOpenStudy ? onOpenStudy(selected.id, "grades") : onStudy()
                  }
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
