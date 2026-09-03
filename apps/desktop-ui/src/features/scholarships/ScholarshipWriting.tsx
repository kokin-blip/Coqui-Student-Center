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

type AutosaveState = "idle" | "saving" | "saved" | "error";

export function WritingSection(props: {
  workspace: ScholarshipWorkspace | null;
  opportunities: ScholarshipOpportunity[];
  active?: ScholarshipOpportunity;
  prompts: { id: string; prompt: string; wordLimit?: number }[];
  currentPrompt?: { id: string; prompt: string; wordLimit?: number };
  promptId: string;
  setPromptId: (value: string) => void;
  setSelected: (value: string) => void;
  storyTitle: string;
  storyDetail: string;
  storyTags: string;
  setStoryTitle: (value: string) => void;
  setStoryDetail: (value: string) => void;
  setStoryTags: (value: string) => void;
  addStory: () => void;
  draft?: ScholarshipDraft;
  draftText: string;
  outline: string;
  setDraftText: (value: string | ((current: string) => string)) => void;
  setOutline: (value: string) => void;
  wordCount: number;
  autosaveState: AutosaveState;
  busy: boolean;
  saveDraftVersion: () => void;
  startApplication: () => void;
  writingPreview: ScholarshipWritingPreview | null;
  setWritingPreview: (value: ScholarshipWritingPreview | null) => void;
  writingConsent: boolean;
  setWritingConsent: (value: boolean) => void;
  policyAcknowledged: boolean;
  setPolicyAcknowledged: (value: boolean) => void;
  selectedSnippets: string[];
  setSelectedSnippets: (
    value: string[] | ((current: string[]) => string[]),
  ) => void;
  previewWriting: () => Promise<void>;
  requestWriting: () => void;
  setMessage: (value: string) => void;
  run: ScholarshipRunAction;
}) {
  const {
    workspace,
    opportunities,
    active,
    prompts,
    currentPrompt,
    promptId,
    setPromptId,
    setSelected,
    storyTitle,
    storyDetail,
    storyTags,
    setStoryTitle,
    setStoryDetail,
    setStoryTags,
    addStory,
    draft,
    draftText,
    outline,
    setDraftText,
    setOutline,
    wordCount,
    autosaveState,
    busy,
    saveDraftVersion,
    startApplication,
    writingPreview,
    setWritingPreview,
    writingConsent,
    setWritingConsent,
    policyAcknowledged,
    setPolicyAcknowledged,
    selectedSnippets,
    setSelectedSnippets,
    previewWriting,
    requestWriting,
    setMessage,
    run,
  } = props;
  return (
    <div className="scholarship-writing">
      <aside className="scholarship-writing-sidebar">
        <section className="scholarship-panel">
          <h2>Requirements</h2>
          {opportunities.length ? (
            <select
              aria-label="Writing opportunity"
              value={active?.id ?? ""}
              onChange={(event) => setSelected(event.target.value)}
            >
              {opportunities.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          ) : (
            <p>Save an opportunity first.</p>
          )}
          {active && (
            <>
              <label>
                Essay prompt
                <select
                  aria-label="Essay prompt"
                  value={promptId}
                  onChange={(event) => setPromptId(event.target.value)}
                >
                  {prompts.map((prompt) => (
                    <option key={prompt.id} value={prompt.id}>
                      {prompt.prompt}
                    </option>
                  ))}
                </select>
              </label>
              <div className="prompt-requirements">
                <p>{currentPrompt?.prompt}</p>
                {currentPrompt?.wordLimit && (
                  <small>Maximum {currentPrompt.wordLimit} words</small>
                )}
                {active.requiredDocuments.length > 0 && (
                  <small>
                    Documents: {active.requiredDocuments.join(", ")}
                  </small>
                )}
                {active.recommendationsRequired !== undefined && (
                  <small>
                    {active.recommendationsRequired} recommendation
                    {active.recommendationsRequired === 1 ? "" : "s"}
                  </small>
                )}
              </div>
              <dl>
                <div>
                  <dt>AI policy</dt>
                  <dd>{active.aiPolicy}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>
                    <a
                      href={active.canonicalUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open requirements
                    </a>
                  </dd>
                </div>
              </dl>
              <button
                className="outline"
                disabled={Boolean(
                  workspace?.applications.some(
                    (item) => item.opportunityId === active.id,
                  ),
                )}
                onClick={startApplication}
              >
                Build checklist
              </button>
            </>
          )}
        </section>
        <section className="scholarship-panel story-library">
          <div>
            <p className="eyebrow">Reusable evidence</p>
            <h2>Story library</h2>
            <p>Keep truthful examples you can adapt for different prompts.</p>
          </div>
          <label>
            Story title
            <input
              value={storyTitle}
              onChange={(event) => setStoryTitle(event.target.value)}
              placeholder="Leading the robotics workshop"
            />
          </label>
          <label>
            What happened
            <textarea
              value={storyDetail}
              onChange={(event) => setStoryDetail(event.target.value)}
              placeholder="Record concrete actions, constraints, and outcomes…"
            />
          </label>
          <label>
            Tags
            <input
              value={storyTags}
              onChange={(event) => setStoryTags(event.target.value)}
              placeholder="leadership, community"
            />
          </label>
          <button
            className="solid"
            disabled={busy || !storyTitle.trim() || !storyDetail.trim()}
            onClick={addStory}
          >
            <Plus />
            Save story
          </button>
          <div className="story-list">
            {workspace?.stories.map((story) => (
              <article key={story.id}>
                <strong>{story.title}</strong>
                <p>{story.detail}</p>
                {story.tags.length > 0 && (
                  <small>{story.tags.join(" · ")}</small>
                )}
                <div>
                  <button
                    className="outline"
                    disabled={!active}
                    onClick={() =>
                      setDraftText(
                        (value) =>
                          `${value}${value.trim() ? "\n\n" : ""}${story.detail}`,
                      )
                    }
                  >
                    <BookOpen />
                    Use in draft
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Delete ${story.title}`}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete “${story.title}” from your story library?`,
                        )
                      )
                        void run(
                          () => deleteScholarshipStory(story.id),
                          "Story example deleted.",
                        );
                    }}
                  >
                    <Trash2 />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </aside>
      <section className="scholarship-panel writing-editor">
        <div>
          <h2>{active ? `${active.title} draft` : "Writing workspace"}</h2>
          <p>
            Write in your voice. Suggestions are optional diffs and are never
            applied automatically.
          </p>
        </div>
        <label className="draft-outline">
          Outline
          <textarea
            value={outline}
            onChange={(event) => setOutline(event.target.value)}
            disabled={!active}
            placeholder="Opening · concrete example · connection to prompt · close"
          />
        </label>
        <label className="draft-body">
          Draft
          <textarea
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            disabled={!active}
            placeholder="Start with the specific experience you want the reviewer to understand…"
          />
        </label>
        <div className="writing-foot">
          <span>
            {wordCount} words
            {currentPrompt?.wordLimit
              ? ` of ${currentPrompt.wordLimit}`
              : ""} · {draft?.versions.length ?? 0} saved versions ·{" "}
            {autosaveState === "saving"
              ? "Saving…"
              : autosaveState === "saved"
                ? "Autosaved"
                : autosaveState === "error"
                  ? "Autosave failed"
                  : draft
                    ? "Saved"
                    : "Save a first version to enable autosave"}
          </span>
          <button
            className="solid"
            disabled={!active || busy}
            onClick={saveDraftVersion}
          >
            Save version
          </button>
        </div>
        {draft && draft.versions.length > 0 && (
          <details className="version-history">
            <summary>
              <History />
              Version history
            </summary>
            <div>
              {[...draft.versions].reverse().map((version) => (
                <article key={version.id}>
                  <span>
                    <strong>
                      {version.source === "student"
                        ? "Saved by you"
                        : "AI suggestion applied"}
                    </strong>
                    <small>
                      {new Date(version.createdAt).toLocaleString()}
                    </small>
                  </span>
                  <button
                    className="outline"
                    onClick={() => {
                      setDraftText(version.content);
                      setMessage(
                        "Older text restored in the editor. Save a version when you are ready.",
                      );
                    }}
                  >
                    Restore
                  </button>
                </article>
              ))}
            </div>
          </details>
        )}
        {draft && (
          <div className="writing-ai">
            <div className="section-head">
              <div>
                <h3>Writing feedback</h3>
                <p>
                  Grammar, structure, specificity, shortening, and
                  brainstorming—without inventing facts.
                </p>
              </div>
              {!writingPreview && (
                <button
                  className="outline"
                  disabled={busy || active?.aiPolicy === "prohibited"}
                  onClick={() => void previewWriting()}
                >
                  Review what will be sent
                </button>
              )}
            </div>
            {active?.aiPolicy === "prohibited" && (
              <p className="policy-warning">
                <AlertTriangle />
                AI assistance is disabled because this opportunity prohibits it.
              </p>
            )}
            {writingPreview && (
              <div className="writing-disclosure">
                <p>
                  <strong>
                    {writingPreview.provider} · {writingPreview.model}
                  </strong>
                  <span>
                    {writingPreview.draftScope.words} words will be sent.{" "}
                    <a
                      href={writingPreview.disclosureUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Provider privacy terms
                    </a>
                  </span>
                </p>
                {writingPreview.profileSnippets.length > 0 && (
                  <fieldset>
                    <legend>Supporting profile and story snippets</legend>
                    {writingPreview.profileSnippets.map((snippet) => (
                      <label key={snippet}>
                        <input
                          type="checkbox"
                          checked={selectedSnippets.includes(snippet)}
                          onChange={(event) =>
                            setSelectedSnippets((values) =>
                              event.target.checked
                                ? [...values, snippet]
                                : values.filter((value) => value !== snippet),
                            )
                          }
                        />
                        {snippet}
                      </label>
                    ))}
                  </fieldset>
                )}
                {writingPreview.policy !== "allowed" && (
                  <label className="consent-row">
                    <input
                      type="checkbox"
                      checked={policyAcknowledged}
                      onChange={(event) =>
                        setPolicyAcknowledged(event.target.checked)
                      }
                    />
                    I reviewed the {writingPreview.policy} AI policy and want to
                    continue.
                  </label>
                )}
                <label className="consent-row">
                  <input
                    type="checkbox"
                    checked={writingConsent}
                    onChange={(event) =>
                      setWritingConsent(event.target.checked)
                    }
                  />
                  Send this draft and the selected snippets to this provider
                  once.
                </label>
                <div className="writing-actions">
                  <button
                    className="outline"
                    onClick={() => setWritingPreview(null)}
                  >
                    Cancel
                  </button>
                  <button
                    className="solid"
                    disabled={
                      busy ||
                      !writingConsent ||
                      (writingPreview.policy !== "allowed" &&
                        !policyAcknowledged)
                    }
                    onClick={requestWriting}
                  >
                    Request suggestions
                  </button>
                </div>
              </div>
            )}
            {workspace?.suggestions
              .filter((item) => item.draftId === draft.id)
              .map((suggestion) => (
                <article className="writing-suggestion" key={suggestion.id}>
                  <header>
                    <strong>{suggestion.kind}</strong>
                    <small>
                      {suggestion.provider} · {suggestion.model}
                    </small>
                  </header>
                  <del>{suggestion.originalQuote}</del>
                  <ins>{suggestion.replacement}</ins>
                  <p>{suggestion.rationale}</p>
                  <div>
                    <button
                      className="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            resolveScholarshipWritingSuggestion(
                              suggestion.id,
                              false,
                            ),
                          "Suggestion dismissed.",
                        )
                      }
                    >
                      Dismiss
                    </button>
                    <button
                      className="solid"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            resolveScholarshipWritingSuggestion(
                              suggestion.id,
                              true,
                            ),
                          "Suggestion applied as a new draft version.",
                        )
                      }
                    >
                      Apply
                    </button>
                  </div>
                </article>
              ))}
          </div>
        )}
      </section>
    </div>
  );
}
