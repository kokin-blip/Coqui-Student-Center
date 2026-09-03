import {
  AlertTriangle,
  Award,
  BookOpen,
  ExternalLink,
  FilePenLine,
  History,
  LibraryBig,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  applyScholarshipRequirementsReview,
  deleteScholarshipStory,
  importScholarshipRequirements,
  planScholarshipDeadline,
  refreshScholarshipSource,
  resolveScholarshipWritingSuggestion,
  saveScholarshipDraft,
  saveScholarshipOpportunity,
  setScholarshipSourceRefresh,
} from "../../native";
import type {
  ScholarshipDraft,
  ScholarshipOpportunity,
  ScholarshipStoryExample,
  ScholarshipWorkspace,
  ScholarshipWritingPreview,
} from "../../native";
import { CoquiProgress } from "../../components/ui/CoquiPrimitives";
import type { ScholarshipRunAction } from "./scholarshipTypes";
import { ScholarshipEmpty, ScholarshipEvidence } from "./ScholarshipEmpty";

export function ApplicationsSection({
  workspace,
  active,
  busy,
  startApplication,
  updateApplication,
  run,
}: {
  workspace: ScholarshipWorkspace | null;
  active?: ScholarshipOpportunity;
  busy: boolean;
  startApplication: () => void;
  updateApplication: (
    application: ScholarshipWorkspace["applications"][number],
    changes: Partial<ScholarshipWorkspace["applications"][number]>,
  ) => void;
  run: ScholarshipRunAction;
}) {
  return (
    <section className="scholarship-panel">
      <h2>Applications</h2>
      {workspace?.applications.length ? (
        <div className="application-list editable-applications">
          {workspace.applications.map((application) => {
            const item = workspace.opportunities.find(
              (opportunity) => opportunity.id === application.opportunityId,
            );
            const done = application.checklist.filter(
              (step) => step.completed,
            ).length;
            return (
              <article key={application.id}>
                <div className="application-heading">
                  <span>
                    <strong>{item?.title ?? "Scholarship application"}</strong>
                    <small>
                      {done}/{application.checklist.length} steps complete
                    </small>
                  </span>
                  <select
                    aria-label={`Status for ${item?.title ?? "scholarship application"}`}
                    value={application.status}
                    onChange={(event) =>
                      updateApplication(application, {
                        status: event.target.value as typeof application.status,
                      })
                    }
                  >
                    {[
                      "saved",
                      "researching",
                      "preparing",
                      "submitted",
                      "awarded",
                      "declined",
                      "archived",
                    ].map((status) => (
                      <option key={status} value={status}>
                        {status[0].toUpperCase() + status.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
                <CoquiProgress
                  value={
                    application.checklist.length
                      ? done / application.checklist.length
                      : 0
                  }
                  label={`${done} of ${application.checklist.length} application steps complete`}
                />
                <fieldset className="application-checklist">
                  <legend>Checklist</legend>
                  {application.checklist.map((step) => (
                    <label key={step.id}>
                      <input
                        type="checkbox"
                        checked={step.completed}
                        onChange={(event) =>
                          updateApplication(application, {
                            checklist: application.checklist.map((value) =>
                              value.id === step.id
                                ? { ...value, completed: event.target.checked }
                                : value,
                            ),
                          })
                        }
                      />
                      <span>{step.label}</span>
                    </label>
                  ))}
                </fieldset>
                <label className="application-notes">
                  Notes
                  <textarea
                    key={application.updatedAt}
                    defaultValue={application.notes}
                    onBlur={(event) => {
                      if (event.target.value !== application.notes)
                        updateApplication(application, {
                          notes: event.target.value,
                        });
                    }}
                    placeholder="Questions, contacts, or submission details"
                  />
                </label>
              </article>
            );
          })}
        </div>
      ) : (
        <ScholarshipEmpty
          icon={<Award />}
          title="No applications in progress"
          copy="Select a saved opportunity, then create a checklist when you are ready to prepare it."
        />
      )}
      {active && (
        <div className="application-actions">
          <button
            className="solid"
            disabled={
              busy ||
              Boolean(
                workspace?.applications.some(
                  (item) => item.opportunityId === active.id,
                ),
              )
            }
            onClick={startApplication}
          >
            <Plus />
            {workspace?.applications.some(
              (item) => item.opportunityId === active.id,
            )
              ? "Checklist created"
              : `Start ${active.title}`}
          </button>
          <button
            className="outline"
            disabled={busy || !active.deadline || active.taskIds.length > 0}
            title={
              !active.deadline
                ? "Verify an exact deadline before planning"
                : active.taskIds.length
                  ? "Deadline task already created"
                  : undefined
            }
            onClick={() =>
              void run(
                () => planScholarshipDeadline(active.id),
                "Deadline task added to your deterministic plan.",
              )
            }
          >
            {active.taskIds.length
              ? "Deadline planned"
              : "Add deadline to plan"}
          </button>
        </div>
      )}
    </section>
  );
}
