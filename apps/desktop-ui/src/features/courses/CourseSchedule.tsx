import type { Dispatch, SetStateAction } from "react";
import { CalendarDays } from "lucide-react";
import {
  createClassMeeting,
  updateClassMeeting,
  deleteClassMeeting,
} from "../../native";
import {
  WorkspaceSnapshot,
  CourseRecord,
  ClassMeetingSeriesRecord,
} from "../../native";
import { emptyMeeting, weekdays } from "./courseModel";
export function CourseSchedule({
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
  setMeeting: Dispatch<SetStateAction<ReturnType<typeof emptyMeeting>>>;
  setMeetingEdit: (value: ClassMeetingSeriesRecord | null) => void;
  act: (operation: () => Promise<WorkspaceSnapshot>) => Promise<boolean>;
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
              ).then((saved) => {
                if (saved) reset();
              });
            }}
          >
            {meetingEdit ? "Save class time" : "Add class time"}
          </button>
        </div>
      </div>
    </div>
  );
}
