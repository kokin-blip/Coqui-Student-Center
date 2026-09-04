import { ShieldCheck } from "lucide-react";
import { Modal } from "../../components/Modal";
import { ScheduleImportReview } from "../../components/ScheduleImportReview";
import type {
  AcademicTermRecord,
  CalendarDiff,
  Dashboard,
  ImportCandidate,
  TermChange,
} from "../../native";

const changeKey = (change: TermChange) => `${change.termName}:${change.field}`;

export function ReviewDialog({
  candidates,
  selectedIds,
  linkedTaskCandidateIds,
  canvasScoped,
  conflictedIds,
  busy,
  terms,
  hasSourceChanges,
  close,
  openConflicts,
  onSelection,
  onLinkedTaskSelection,
  onDashboard,
  onError,
  decide,
}: {
  candidates: ImportCandidate[];
  selectedIds: string[];
  linkedTaskCandidateIds: string[];
  canvasScoped: boolean;
  conflictedIds: Set<string>;
  busy: boolean;
  terms: AcademicTermRecord[];
  hasSourceChanges: boolean;
  close: () => void;
  openConflicts: () => void;
  onSelection: (ids: string[]) => void;
  onLinkedTaskSelection: (ids: string[]) => void;
  onDashboard: (dashboard: Dashboard) => void;
  onError: (message: string) => void;
  decide: (choice: "approve" | "reject") => void;
}) {
  return (
    <Modal
      title={canvasScoped ? "Review Canvas imports" : "Review extracted facts"}
      subtitle={
        canvasScoped
          ? "Assignments go to Work. Timed events go to Calendar, with an optional linked to-do."
          : "Every candidate shows its source evidence. Approve only what is correct."
      }
      close={close}
    >
      {candidates.length ? (
        <>
          <ScheduleImportReview
            candidates={candidates}
            selectedIds={selectedIds}
            linkedTaskCandidateIds={linkedTaskCandidateIds}
            canvasScoped={canvasScoped}
            conflictedIds={conflictedIds}
            busy={busy}
            onSelection={onSelection}
            onLinkedTaskSelection={onLinkedTaskSelection}
            onDashboard={onDashboard}
            onError={onError}
            terms={terms}
          />
          <div className="modal-actions split-actions">
            <button
              className="outline danger"
              disabled={!selectedIds.length || busy}
              onClick={() => decide("reject")}
            >
              Ignore selected
            </button>
            <span />
            <button className="outline" onClick={close}>Keep for later</button>
            {hasSourceChanges && (
              <button className="outline" onClick={openConflicts}>
                Resolve date changes
              </button>
            )}
            <button
              className="solid"
              disabled={!selectedIds.length || busy}
              onClick={() => decide("approve")}
            >
              Approve and plan
            </button>
          </div>
        </>
      ) : (
        <div className="empty">
          No candidates are waiting for review. The encrypted source remains
          available in your vault.
        </div>
      )}
    </Modal>
  );
}

export function RetentionDialog({
  count,
  busy,
  close,
  choose,
}: {
  count: number;
  busy: boolean;
  close: () => void;
  choose: (choice: "delete_now" | "keep_encrypted") => void;
}) {
  return (
    <Modal
      title="Keep the schedule source?"
      subtitle="Your approved classes and evidence stay either way."
      close={close}
    >
      <div className="consent-box">
        <ShieldCheck aria-hidden="true" />
        <div>
          <strong>Your choice, every import</strong>
          <p>
            Keep the original image or document encrypted for later review, or
            delete the source now. Coqui never makes this choice silently.
          </p>
        </div>
      </div>
      {count > 1 && (
        <p className="field-help">
          Source 1 of {count}. You will choose separately for every imported
          source file.
        </p>
      )}
      <div className="modal-actions">
        <button
          className="outline danger"
          disabled={busy || !count}
          onClick={() => choose("delete_now")}
        >
          Delete source now
        </button>
        <button
          className="solid"
          disabled={busy || !count}
          onClick={() => choose("keep_encrypted")}
        >
          Keep encrypted source
        </button>
      </div>
    </Modal>
  );
}

export function CalendarRefreshDialog({
  diff,
  declinedChanges,
  busy,
  close,
  setDeclinedChanges,
  apply,
}: {
  diff: CalendarDiff;
  declinedChanges: string[];
  busy: boolean;
  close: () => void;
  setDeclinedChanges: (values: string[]) => void;
  apply: () => void;
}) {
  const hasChanges = Boolean(
    diff.changedTerms.length || diff.addedNoClassDates.length,
  );
  return (
    <Modal
      title="Your school's calendar"
      subtitle={`Read from ${diff.sourceLabel || "the registrar"} just now. Nothing changes until you approve it.`}
      close={close}
    >
      {hasChanges ? (
        <>
          {diff.changedTerms.length > 0 && (
            <div className="candidate-list">
              <p className="field-help">
                A term date is a critical academic date, so each one is shown
                with the value you have now beside the one the registrar
                publishes. Anything you edited yourself is left alone.
              </p>
              {diff.changedTerms.map((change) => {
                const key = changeKey(change);
                const declined = declinedChanges.includes(key);
                return (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={!declined}
                      onChange={(event) =>
                        setDeclinedChanges(
                          event.target.checked
                            ? declinedChanges.filter((value) => value !== key)
                            : [...declinedChanges, key],
                        )
                      }
                    />
                    <span>
                      <strong>{change.termName}</strong>
                      <small>
                        {change.field} · {change.current || "unset"} → {change.proposed}
                      </small>
                      <q>{change.evidence}</q>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {diff.addedNoClassDates.length > 0 && (
            <div className="candidate-list">
              <p className="field-help">
                Holidays and breaks. Approving these stops the planner scheduling
                on those days.
              </p>
              {diff.addedNoClassDates.map((date) => (
                <label key={`${date.startsOn}-${date.label}`}>
                  <input type="checkbox" checked readOnly />
                  <span>
                    <strong>{date.label}</strong>
                    <small>{date.startsOn}{date.endsOn ? ` – ${date.endsOn}` : ""}</small>
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className="modal-actions split-actions">
            <span />
            <button className="outline" onClick={close}>Not now</button>
            <button className="solid" disabled={busy} onClick={apply}>
              Apply selected
            </button>
          </div>
        </>
      ) : (
        <div className="empty compact-empty">
          Your calendar already matches what {diff.sourceLabel || "your school"} publishes.
        </div>
      )}
    </Modal>
  );
}

export { changeKey };
