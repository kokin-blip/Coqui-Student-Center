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
import { useMemo, useState } from "react";
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
import { FundingResultsControls } from "./FundingResultsControls";
import { defaultFundingFilters, fundingPreferenceFit, fundingResults } from "./fundingResults";

export function DiscoverSection({
  workspace,
  discovered,
  busy,
  title,
  provider,
  url,
  deadline,
  setTitle,
  setProvider,
  setUrl,
  setDeadline,
  addManual,
  run,
}: {
  workspace: ScholarshipWorkspace | null;
  discovered: ScholarshipOpportunity[];
  busy: boolean;
  title: string;
  provider: string;
  url: string;
  deadline: string;
  setTitle: (value: string) => void;
  setProvider: (value: string) => void;
  setUrl: (value: string) => void;
  setDeadline: (value: string) => void;
  addManual: () => void;
  run: ScholarshipRunAction;
}) {
  const [filters, setFilters] = useState(defaultFundingFilters);
  const displayed = useMemo(() => workspace ? fundingResults(discovered, workspace.matches, workspace.profile, filters) : [], [discovered, workspace, filters]);
  return (
    <div className="scholarship-grid">
      <section className="scholarship-panel">
        <div className="section-head">
          <div>
            <h2>Trusted sources</h2>
            <p>
              Public adapters stay allowlisted. Signed-in databases open in your
              browser and are never crawled.
            </p>
          </div>
        </div>
        <div className="source-list">
          {workspace?.sources
            .filter((source) => source.id !== "manual")
            .map((source) => (
              <article key={source.id}>
                <span>
                  <strong>{source.name}</strong>
                  <small>
                    {source.status === "error" && source.lastError
                      ? `${source.lastError} Cached opportunities remain available.`
                      : source.lastFetchedAt
                      ? `Last checked ${new Date(source.lastFetchedAt).toLocaleString()}`
                      : source.status === "disabled"
                        ? (source.lastError ??
                          "Open this source to search manually")
                        : "Not checked yet"}
                  </small>
                  {source.kind === "catalog" && source.status !== "disabled" && <small>Signed public opportunities. Your profile stays on this device.</small>}
                  {source.status !== "disabled" && (
                    <label className="source-refresh-toggle">
                      <input
                        type="checkbox"
                        checked={Boolean(source.weeklyRefresh)}
                        onChange={(event) =>
                          void run(
                            () =>
                              setScholarshipSourceRefresh(
                                source.id,
                                event.target.checked,
                              ),
                            event.target.checked
                              ? "Weekly refresh enabled."
                              : "Weekly refresh disabled.",
                          )
                        }
                      />
                      {source.kind === "catalog" ? "Automatic daily" : "Weekly"}
                    </label>
                  )}
                </span>
                <div>
                  {source.kind !== "catalog" && <a
                    href={source.origin}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${source.name}`}
                  >
                    <ExternalLink />
                  </a>}
                  {source.status !== "disabled" && (
                    <button
                      className="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => refreshScholarshipSource(source.id),
                          "Source refreshed. New and changed opportunities are ready for review.",
                        )
                      }
                    >
                      <RefreshCw />
                      Refresh
                    </button>
                  )}
                </div>
              </article>
            ))}
        </div>
        {discovered.length > 0 && (
          <div className="discovered-list">
            <h3>Newly discovered</h3>
            <FundingResultsControls filters={filters} onChange={setFilters} count={displayed.length} total={discovered.length} gpa={workspace?.profile.gpa ?? null} />
            {displayed.map((item) => {
              const preference = workspace ? fundingPreferenceFit(item, workspace.profile) : null;
              return (
              <article key={item.id}>
                <span>
                  <strong>{item.title}</strong>
                  <small>
                    {item.provider} · {(item.opportunityType ?? "scholarship").replaceAll("_", " ")} · {" "}
                    {item.awardMaximum
                      ? `Up to $${item.awardMaximum.toLocaleString()}`
                      : "Award varies"}{" "}
                    · {item.deadline ? `Due ${new Date(`${item.deadline}T12:00:00`).toLocaleDateString()}` : item.deadlineLabel || "Deadline not published"}
                  </small>
                  {preference && preference.reasons.length > 0 && <small>Profile preferences: {preference.reasons.join(" · ")}. These do not establish eligibility.</small>}
                </span>
                <button
                  className="solid"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        saveScholarshipOpportunity({ ...item, state: "saved" }),
                      "Scholarship saved to your encrypted local workspace.",
                    )
                  }
                >
                  Save
                </button>
              </article>
              );
            })}
            {displayed.length === 0 && <p className="funding-no-results">No discovered opportunities match these filters. Clear filters to see everything.</p>}
          </div>
        )}
      </section>
      <section className="scholarship-panel manual-scholarship-form">
        <h2>Add an opportunity</h2>
        <p className="panel-copy">
          Paste a public source page or import supporting requirements. Coqui
          keeps attribution and asks you to verify details.
        </p>
        <label>
          Opportunity title
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Scholarship name"
          />
        </label>
        <label>
          Provider
          <input
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            placeholder="Organization"
          />
        </label>
        <label>
          Public HTTPS URL
          <input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://…"
          />
        </label>
        <label>
          Deadline
          <input
            type="date"
            value={deadline}
            onChange={(event) => setDeadline(event.target.value)}
          />
        </label>
        <div className="manual-scholarship-actions">
          <button
            className="solid"
            disabled={busy || !title || !provider || !url}
            onClick={addManual}
          >
            <Plus />
            Save opportunity
          </button>
        </div>
      </section>
    </div>
  );
}
