import { useEffect, useState } from "react";
import { ChevronRight, ListChecks } from "lucide-react";
import {
  addTask,
  getLocalWorkspace,
  type CourseRecord,
  type Dashboard,
} from "../native";
import { Modal } from "./Modal";

type QuickAddTaskModalProps = {
  close: () => void;
  openDetailed: () => void;
  saved: (dashboard: Dashboard) => void;
};

export function QuickAddTaskModal({
  close,
  openDetailed,
  saved,
}: QuickAddTaskModalProps) {
  const [title, setTitle] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [due, setDue] = useState("");
  const [courseId, setCourseId] = useState("");
  const [courses, setCourses] = useState<CourseRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    getLocalWorkspace()
      .then((workspace) => {
        if (active) setCourses(workspace.courses);
      })
      .catch(() => {
        if (active) setCourses([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const dashboard = await addTask(
        title.trim(),
        minutes,
        due ? new Date(due).toISOString() : undefined,
        courseId || undefined,
      );
      saved(dashboard);
      close();
    } catch (next) {
      setError(String(next));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Quick add"
      subtitle="Capture an assignment now, or use the detailed editor for exams and constraints."
      close={close}
    >
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      <label className="field">
        Assignment title
        <input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Finish statistics problem set"
        />
      </label>
      <label className="field">
        Estimate in minutes
        <input
          type="number"
          min="5"
          max="480"
          step="5"
          value={minutes}
          onChange={(event) => setMinutes(Number(event.target.value))}
        />
      </label>
      <label className="field">
        Due (optional)
        <input
          type="datetime-local"
          value={due}
          onChange={(event) => setDue(event.target.value)}
        />
      </label>
      {courses.length > 0 && (
        <label className="field">
          Course (optional)
          <select
            value={courseId}
            onChange={(event) => setCourseId(event.target.value)}
          >
            <option value="">No course</option>
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.code
                  ? `${course.code} · ${course.title}`
                  : course.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="modal-actions">
        <button className="outline" onClick={close}>
          Cancel
        </button>
        <button
          className="solid"
          disabled={!title.trim() || busy}
          onClick={() => void submit()}
        >
          {busy ? "Adding…" : "Add assignment"}
        </button>
      </div>
      <button className="quick-add-detailed" onClick={openDetailed}>
        <ListChecks /> Add an exam or detailed assignment
        <ChevronRight />
      </button>
    </Modal>
  );
}
