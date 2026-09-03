import type {
  WorkspaceSnapshot,
  CommitmentEditorInput,
  CommitmentRecord,
  AcademicCalendarEventInput,
  AcademicCalendarEventRecord,
} from "../../native";
import {
  createCommitment,
  updateCommitment,
  createAcademicEvent,
  updateAcademicEvent,
} from "../../native";
import { dateTimeValue as localValue } from "../tasks/taskEditorModel";

export const emptyCommitment = (): CommitmentEditorInput => ({
  title: "",
  startsAt: "",
  endsAt: "",
  kind: "class",
  location: "",
  travelBeforeMinutes: 0,
  travelAfterMinutes: 0,
  protected: true,
});
export const emptyAcademicEvent = (): AcademicCalendarEventInput => {
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

export function CalendarInspector({
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
  act: (operation: () => Promise<WorkspaceSnapshot>) => Promise<boolean>;
}) {
  return (
    <aside className="workspace-panel editor calendar-inspector">
      <h2>{commitmentEdit ? "Edit commitment" : "Add commitment"}</h2>
      <p className="field-help">Date and time inputs use this computer’s timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
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
            ).then((saved) => {
              if (!saved) return;
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
            ).then((saved) => {
              if (!saved) return;
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
