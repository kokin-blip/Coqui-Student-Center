import { ChevronRight, CircleAlert } from "lucide-react";
import type { Dashboard } from "../../native";
import { Modal } from "../../components/Modal";

const formatDateTime = (iso?: string) =>
  iso
    ? new Intl.DateTimeFormat([], {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(iso))
    : "Not set";

export function PlanningDialogs({
  active,
  dashboard,
  busy,
  replanReason,
  close,
  openReplan,
  setReplanReason,
  resolveConflict,
  submitReplan,
}: {
  active: "conflicts" | "replan" | null;
  dashboard: Dashboard;
  busy: boolean;
  replanReason: string;
  close: () => void;
  openReplan: () => void;
  setReplanReason: (reason: string) => void;
  resolveConflict: (
    id: string,
    resolution: "keep_existing" | "use_source",
    successMessage: string,
  ) => void;
  submitReplan: () => void;
}) {
  if (active === "conflicts") {
    return (
      <Modal
        title="Resolve planning conflicts"
        subtitle="Student Center never replaces a critical date silently. Compare the current value with the newest source evidence."
        close={close}
      >
        {dashboard.conflicts.length ? (
          <div className="conflict-list">
            {dashboard.conflicts.map((conflict) => {
              const candidate = dashboard.candidates.find(
                (item) => item.id === conflict.candidateId,
              );
              const critical = ["source_change", "sync_critical_date"].includes(
                conflict.kind,
              );
              const ranged = ["commitment", "academic_term"].includes(
                conflict.entityType ?? "",
              );
              return (
                <article className="conflict-card" key={conflict.id}>
                  <div className="conflict-title">
                    <CircleAlert aria-hidden="true" />
                    <span>
                      <strong>{candidate?.title ?? "Planning overload"}</strong>
                      <small>{conflict.description}</small>
                    </span>
                  </div>
                  {critical ? (
                    <>
                      <div className="conflict-compare">
                        <div>
                          <small>Current plan</small>
                          <strong>
                            {ranged
                              ? `${formatDateTime(conflict.currentStartsAt)} – ${formatDateTime(conflict.currentEndsAt)}`
                              : formatDateTime(conflict.currentDueAt)}
                          </strong>
                        </div>
                        <ChevronRight aria-hidden="true" />
                        <div>
                          <small>
                            {conflict.kind === "sync_critical_date"
                              ? "Newest device value"
                              : "Newest Canvas value"}
                          </small>
                          <strong>
                            {ranged
                              ? `${formatDateTime(conflict.proposedStartsAt)} – ${formatDateTime(conflict.proposedEndsAt)}`
                              : formatDateTime(conflict.proposedDueAt)}
                          </strong>
                        </div>
                      </div>
                      {candidate && <q>{candidate.evidence}</q>}
                      <div className="conflict-actions">
                        <button
                          className="outline"
                          disabled={busy}
                          onClick={() =>
                            resolveConflict(
                              conflict.id,
                              "keep_existing",
                              "Your current value was preserved.",
                            )
                          }
                        >
                          Keep my current value
                        </button>
                        <button
                          className="solid"
                          disabled={busy}
                          onClick={() =>
                            resolveConflict(
                              conflict.id,
                              "use_source",
                              "Canvas value accepted and plan rebuilt.",
                            )
                          }
                        >
                          Use Canvas value
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="conflict-actions">
                      <button className="solid" onClick={openReplan}>
                        Adjust my plan
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty">All conflicts are resolved.</div>
        )}
      </Modal>
    );
  }

  if (active !== "replan") return null;
  return (
    <Modal
      title="What changed?"
      subtitle="Completed, past, fixed, and locked blocks remain protected."
      close={close}
    >
      <div className="options">
        {[
          "I woke up late",
          "This took 30 minutes longer",
          "I have less energy",
          "Replan everything after now",
        ].map((reason) => (
          <button
            className={reason === replanReason ? "active" : ""}
            key={reason}
            onClick={() => setReplanReason(reason)}
          >
            {reason}
          </button>
        ))}
      </div>
      <div className="modal-actions">
        <button className="outline" onClick={close}>
          Keep current plan
        </button>
        <button className="solid" disabled={busy} onClick={submitReplan}>
          Build a realistic plan
        </button>
      </div>
    </Modal>
  );
}
