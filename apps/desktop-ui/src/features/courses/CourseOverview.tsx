import type { Dispatch, SetStateAction } from "react";
import { BookOpen } from "lucide-react";
import {
  createInstructor,
  updateInstructor,
  deleteInstructor,
} from "../../native";
import {
  WorkspaceSnapshot,
  CourseRecord,
  InstructorRecord,
} from "../../native";
import { emptyInstructor } from "./courseModel";
export function CourseOverview({
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
  setInstructor: Dispatch<SetStateAction<ReturnType<typeof emptyInstructor>>>;
  setInstructorEdit: (value: InstructorRecord | null) => void;
  act: (operation: () => Promise<WorkspaceSnapshot>) => Promise<boolean>;
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
              ).then((saved) => {
                if (saved) reset();
              });
            }}
          >
            {instructorEdit ? "Save instructor" : "Add instructor"}
          </button>
        </div>
      </div>
    </div>
  );
}
