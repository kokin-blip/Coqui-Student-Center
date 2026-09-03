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

export function SavedSection({
  workspace,
  opportunities,
  active,
  match,
  query,
  busy,
  profileOpen,
  setQuery,
  setSelected,
  setProfileOpen,
  updateProfile,
  run,
}: {
  workspace: ScholarshipWorkspace | null;
  opportunities: ScholarshipOpportunity[];
  active?: ScholarshipOpportunity;
  match?: ScholarshipWorkspace["matches"][number];
  query: string;
  busy: boolean;
  profileOpen: boolean;
  setQuery: (value: string) => void;
  setSelected: (value: string) => void;
  setProfileOpen: (value: boolean) => void;
  updateProfile: (form: HTMLFormElement) => void;
  run: ScholarshipRunAction;
}) {
  return (
    <div className="scholarship-saved-layout">
      <section className="scholarship-panel">
        <div className="section-head">
          <div>
            <h2>Saved opportunities</h2>
            <p>
              Every match remains explainable; unknown eligibility is never
              guessed.
            </p>
          </div>
          <label className="scholarship-search">
            <Search />
            <input
              aria-label="Search saved scholarships"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search saved"
            />
          </label>
        </div>
        {opportunities.length ? (
          <div className="opportunity-list">
            {opportunities.map((item) => {
              const itemMatch = workspace?.matches.find(
                (value) => value.opportunityId === item.id,
              );
              return (
                <button
                  key={item.id}
                  className={active?.id === item.id ? "selected" : ""}
                  onClick={() => setSelected(item.id)}
                >
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      {item.provider}
                      {item.deadline
                        ? ` · Due ${new Date(`${item.deadline}T12:00:00`).toLocaleDateString()}`
                        : item.deadlineLabel
                          ? ` · ${item.deadlineLabel}`
                          : " · Deadline unknown"}
                    </small>
                  </span>
                  <b>
                    {itemMatch
                      ? `${Math.round(itemMatch.score * 100)}% known match`
                      : item.verificationStatus}
                  </b>
                </button>
              );
            })}
          </div>
        ) : (
          <ScholarshipEmpty
            icon={<LibraryBig />}
            title="No saved scholarships yet"
            copy="Add a public opportunity in Discover. Coqui will keep the source and verification state with it."
          />
        )}
      </section>
      <aside className="scholarship-panel match-inspector">
        <div className="section-head">
          <div>
            <h2>Eligibility evidence</h2>
            <p>
              Only compares details you enter with criteria the provider
              publishes.
            </p>
          </div>
          <button
            className="outline"
            onClick={() => setProfileOpen(!profileOpen)}
          >
            {profileOpen ? "Close profile" : "Edit profile"}
          </button>
        </div>
        {profileOpen && workspace && (
          <form
            className="scholarship-profile"
            onSubmit={(event) => {
              event.preventDefault();
              updateProfile(event.currentTarget);
            }}
          >
            <p>
              <ShieldCheck />
              Coqui never infers identity, citizenship, residency, or academic
              details.
            </p>
            <label>
              Study level
              <input
                name="studyLevel"
                defaultValue={workspace.profile.studyLevel}
                placeholder="Undergraduate"
              />
            </label>
            <label>
              Fields of study, comma separated
              <input
                name="fieldsOfStudy"
                defaultValue={workspace.profile.fieldsOfStudy.join(", ")}
                placeholder="Computer science, Design"
              />
            </label>
            <label>
              Locations, comma separated
              <input
                name="locations"
                defaultValue={workspace.profile.locations.join(", ")}
                placeholder="Arizona, United States"
              />
            </label>
            <label>
              Citizenship, comma separated
              <input
                name="citizenship"
                defaultValue={workspace.profile.citizenship.join(", ")}
              />
            </label>
            <label>
              Residency, comma separated
              <input
                name="residency"
                defaultValue={workspace.profile.residency.join(", ")}
              />
            </label>
            <label>
              GPA
              <input
                name="gpa"
                type="number"
                min="0"
                max="5"
                step="0.01"
                defaultValue={workspace.profile.gpa ?? ""}
              />
            </label>
            <button className="solid" disabled={busy}>
              Save matching profile
            </button>
          </form>
        )}
        {!profileOpen && active && match ? (
          <div className="match-evidence">
            <h3>{active.title}</h3>
            {match.ineligible.length > 0 && (
              <ScholarshipEvidence
                title="Does not currently match"
                items={match.ineligible}
                tone="danger"
              />
            )}
            {match.matched.length > 0 && (
              <ScholarshipEvidence
                title="Matches"
                items={match.matched.map(
                  (item) =>
                    `${item.attribute}: ${item.profileValue} (${item.requirement})`,
                )}
                tone="success"
              />
            )}
            <ScholarshipEvidence title="Still unknown" items={match.unknown} />
          </div>
        ) : (
          !profileOpen && (
            <p>Select a saved opportunity to inspect its match.</p>
          )
        )}
        {active && (
          <RequirementSources
            workspace={workspace}
            opportunity={active}
            busy={busy}
            run={run}
          />
        )}
      </aside>
    </div>
  );
}

function RequirementSources({
  workspace,
  opportunity,
  busy,
  run,
}: {
  workspace: ScholarshipWorkspace | null;
  opportunity: ScholarshipOpportunity;
  busy: boolean;
  run: ScholarshipRunAction;
}) {
  const documents =
    workspace?.documents.filter(
      (document) => document.opportunityId === opportunity.id,
    ) ?? [];
  return (
    <section
      className="scholarship-requirement-sources"
      aria-labelledby="requirement-sources-title"
    >
      <div className="section-head">
        <div>
          <h3 id="requirement-sources-title">Requirement sources</h3>
          <p>
            Attach a provider file. Coqui encrypts the original and waits for
            you to review extracted requirements and prompts.
          </p>
        </div>
        <label className={`outline file-action${busy ? " disabled" : ""}`}>
          Import file
          <input
            type="file"
            disabled={busy}
            accept=".pdf,.png,.jpg,.jpeg,.docx,.pptx,.txt"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file)
                void run(
                  () => importScholarshipRequirements(opportunity.id, file),
                  "Requirements extracted locally. Review the suggested details before applying them.",
                );
              event.currentTarget.value = "";
            }}
          />
        </label>
      </div>
      {documents.length === 0 ? (
        <p className="source-note">No requirement files attached yet.</p>
      ) : (
        <div className="requirement-document-list">
          {documents.map((document) => (
            <article key={document.id}>
              <div>
                <strong>{document.fileName}</strong>
                <small>
                  {document.status === "reviewed"
                    ? "Reviewed and applied"
                    : document.status === "needs_attention"
                      ? "Needs manual review"
                      : "Review required"}
                  {` · ${new Date(document.importedAt).toLocaleDateString()}`}
                </small>
              </div>
              {document.warnings.map((warning) => (
                <p className="source-note" key={warning}>
                  {warning}
                </p>
              ))}
              {document.status === "review_required" && (
                <form
                  className="requirement-review"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void run(
                      () =>
                        applyScholarshipRequirementsReview(
                          document.id,
                          form.getAll("requirement").map(String),
                          form.getAll("prompt").map(String),
                        ),
                      "Reviewed scholarship details applied.",
                    );
                  }}
                >
                  {document.proposedRequirements.length > 0 && (
                    <fieldset>
                      <legend>Required documents</legend>
                      {document.proposedRequirements.map((requirement) => (
                        <label key={requirement}>
                          <input
                            type="checkbox"
                            name="requirement"
                            value={requirement}
                            defaultChecked
                          />
                          {requirement}
                        </label>
                      ))}
                    </fieldset>
                  )}
                  {document.proposedPrompts.length > 0 && (
                    <fieldset>
                      <legend>Essay prompts</legend>
                      {document.proposedPrompts.map((prompt) => (
                        <label key={prompt.id}>
                          <input
                            type="checkbox"
                            name="prompt"
                            value={prompt.id}
                            defaultChecked
                          />
                          <span>
                            {prompt.prompt}
                            {prompt.wordLimit
                              ? ` (${prompt.wordLimit} words)`
                              : ""}
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  )}
                  <button className="solid" disabled={busy}>
                    Apply selected details
                  </button>
                </form>
              )}
              {document.status === "reviewed" && (
                <small className="source-note">
                  {document.selectedRequirements.length} requirement
                  {document.selectedRequirements.length === 1
                    ? ""
                    : "s"} and {document.selectedPromptIds.length} prompt
                  {document.selectedPromptIds.length === 1 ? "" : "s"} applied.
                </small>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
