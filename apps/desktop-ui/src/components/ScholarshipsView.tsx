import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
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
  autosaveScholarshipDraft,
  applyScholarshipRequirementsReview,
  deleteScholarshipStory,
  getScholarshipWorkspace,
  importScholarshipRequirements,
  planScholarshipDeadline,
  previewScholarshipWriting,
  refreshScholarshipSource,
  requestScholarshipWritingFeedback,
  resolveScholarshipDiff,
  resolveScholarshipWritingSuggestion,
  saveScholarshipApplication,
  saveScholarshipDraft,
  saveScholarshipOpportunity,
  saveScholarshipProfile,
  saveScholarshipStory,
  setScholarshipSourceRefresh,
} from "../native";
import type {
  ScholarshipDraft,
  ScholarshipOpportunity,
  ScholarshipStoryExample,
  ScholarshipWorkspace,
  ScholarshipWritingPreview,
} from "../native";
import { AnimatedContent, CoquiProgress } from "./ui/CoquiPrimitives";

type Section = "discover" | "saved" | "applications" | "writing";
type AutosaveState = "idle" | "saving" | "saved" | "error";

export function ScholarshipsView() {
  const [section, setSection] = useState<Section>("discover");
  const [workspace, setWorkspace] = useState<ScholarshipWorkspace | null>(null);
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [provider, setProvider] = useState("");
  const [url, setUrl] = useState("");
  const [deadline, setDeadline] = useState("");
  const [selected, setSelected] = useState("");
  const [draftText, setDraftText] = useState("");
  const [promptId, setPromptId] = useState("general");
  const [outline, setOutline] = useState("");
  const [storyTitle, setStoryTitle] = useState("");
  const [storyDetail, setStoryDetail] = useState("");
  const [storyTags, setStoryTags] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [autosaveState, setAutosaveState] = useState<AutosaveState>("idle");
  const [writingPreview, setWritingPreview] =
    useState<ScholarshipWritingPreview | null>(null);
  const [writingConsent, setWritingConsent] = useState(false);
  const [policyAcknowledged, setPolicyAcknowledged] = useState(false);
  const [selectedSnippets, setSelectedSnippets] = useState<string[]>([]);

  useEffect(() => {
    void getScholarshipWorkspace()
      .then(setWorkspace)
      .catch((error) => setMessage(String(error)));
  }, []);
  const opportunities = useMemo(
    () =>
      workspace?.opportunities.filter(
        (item) =>
          item.state !== "discovered" &&
          `${item.title} ${item.provider}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ) ?? [],
    [workspace, query],
  );
  const discovered = useMemo(
    () =>
      workspace?.opportunities.filter((item) => item.state === "discovered") ??
      [],
    [workspace],
  );
  const active =
    workspace?.opportunities.find((item) => item.id === selected) ??
    opportunities[0] ??
    discovered[0];
  const prompts = useMemo(
    () =>
      active?.essayPrompts.length
        ? active.essayPrompts
        : [{ id: "general", prompt: "General scholarship essay" }],
    [active],
  );
  const draft =
    active &&
    workspace?.drafts.find(
      (item) => item.opportunityId === active.id && item.promptId === promptId,
    );
  const match =
    active &&
    workspace?.matches.find((item) => item.opportunityId === active.id);
  const currentPrompt =
    prompts.find((item) => item.id === promptId) ?? prompts[0];
  const wordCount = draftText.trim() ? draftText.trim().split(/\s+/).length : 0;

  useEffect(() => {
    if (!prompts.some((prompt) => prompt.id === promptId))
      setPromptId(prompts[0]?.id ?? "general");
  }, [promptId, prompts]);
  useEffect(() => {
    setDraftText(draft?.content ?? "");
    setOutline(draft?.outline ?? "");
    setAutosaveState("idle");
  }, [draft?.id]);
  useEffect(() => {
    setWritingPreview(null);
    setWritingConsent(false);
    setPolicyAcknowledged(false);
    setSelectedSnippets([]);
  }, [draft?.id]);
  useEffect(() => {
    if (!draft || (draft.content === draftText && draft.outline === outline))
      return;
    setAutosaveState("saving");
    let current = true;
    const timer = window.setTimeout(() => {
      void autosaveScholarshipDraft({ ...draft, content: draftText, outline })
        .then((value) => {
          if (!current) return;
          setWorkspace(value);
          setAutosaveState("saved");
        })
        .catch(() => {
          if (current) setAutosaveState("error");
        });
    }, 900);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [draft, draftText, outline]);

  const run = async (
    action: () => Promise<ScholarshipWorkspace>,
    success: string,
  ) => {
    setBusy(true);
    setMessage("");
    try {
      setWorkspace(await action());
      setMessage(success);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const addManual = () => {
    if (!title.trim() || !provider.trim() || !url.trim()) return;
    const now = new Date().toISOString();
    const item: ScholarshipOpportunity = {
      id: crypto.randomUUID(),
      sourceId: "manual",
      canonicalUrl: url.trim(),
      provider: provider.trim(),
      title: title.trim(),
      deadline: deadline || undefined,
      datePrecision: deadline ? "date" : undefined,
      applicationUrl: url.trim(),
      studyLevels: [],
      fieldsOfStudy: [],
      locations: [],
      citizenship: [],
      residency: [],
      essayPrompts: [],
      requiredDocuments: [],
      fetchedAt: now,
      freshness: "unknown",
      verificationStatus: "unverified",
      aiPolicy: "unknown",
      notes: "",
      priority: "medium",
      state: "saved",
      taskIds: [],
    };
    void run(
      () => saveScholarshipOpportunity(item),
      "Scholarship saved to your encrypted local workspace.",
    );
    setTitle("");
    setProvider("");
    setUrl("");
    setDeadline("");
  };

  const startApplication = () => {
    if (
      !active ||
      workspace?.applications.some((item) => item.opportunityId === active.id)
    )
      return;
    const documentSteps = active.requiredDocuments.map((document) => ({
      id: crypto.randomUUID(),
      label: `Collect ${document}`,
      completed: false,
    }));
    const recommendationSteps = Array.from(
      { length: active.recommendationsRequired ?? 0 },
      (_, index) => ({
        id: crypto.randomUUID(),
        label: `Request recommendation ${index + 1}`,
        completed: false,
      }),
    );
    void run(
      () =>
        saveScholarshipApplication({
          id: `application:${active.id}`,
          opportunityId: active.id,
          status: "preparing",
          checklist: [
            {
              id: crypto.randomUUID(),
              label: "Verify eligibility and deadline",
              completed: false,
            },
            ...documentSteps,
            ...recommendationSteps,
            {
              id: crypto.randomUUID(),
              label: "Review and submit on provider site",
              completed: false,
            },
          ],
          notes: "",
          updatedAt: new Date().toISOString(),
        }),
      "Application checklist created.",
    );
  };

  const saveDraftVersion = () => {
    if (!active) return;
    const value: ScholarshipDraft = {
      id: draft?.id ?? `draft:${active.id}:${promptId}`,
      opportunityId: active.id,
      promptId,
      title:
        draft?.title ?? `${active.title} · ${currentPrompt?.prompt ?? "Essay"}`,
      outline,
      content: draftText,
      wordLimit: currentPrompt?.wordLimit,
      updatedAt: new Date().toISOString(),
      versions: draft?.versions ?? [],
    };
    void run(() => saveScholarshipDraft(value), "Draft version saved locally.");
  };

  const updateApplication = (
    application: ScholarshipWorkspace["applications"][number],
    changes: Partial<ScholarshipWorkspace["applications"][number]>,
  ) => {
    const next = {
      ...application,
      ...changes,
      updatedAt: new Date().toISOString(),
    };
    void run(async () => {
      const opportunity = workspace?.opportunities.find(
        (item) => item.id === application.opportunityId,
      );
      if (opportunity && changes.status)
        await saveScholarshipOpportunity({
          ...opportunity,
          state: changes.status,
        });
      return saveScholarshipApplication(next);
    }, "Application progress saved locally.");
  };

  const addStory = () => {
    if (!storyTitle.trim() || !storyDetail.trim()) return;
    const story: ScholarshipStoryExample = {
      id: crypto.randomUUID(),
      title: storyTitle.trim(),
      detail: storyDetail.trim(),
      tags: storyTags
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 20),
      updatedAt: new Date().toISOString(),
    };
    void run(() => saveScholarshipStory(story), "Story example saved locally.");
    setStoryTitle("");
    setStoryDetail("");
    setStoryTags("");
  };

  const updateProfile = (form: HTMLFormElement) => {
    const data = new FormData(form);
    const list = (name: string) =>
      String(data.get(name) ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const gpa = String(data.get("gpa") ?? "").trim();
    void run(
      () =>
        saveScholarshipProfile({
          studyLevel: String(data.get("studyLevel") ?? "").trim(),
          fieldsOfStudy: list("fieldsOfStudy"),
          locations: list("locations"),
          citizenship: list("citizenship"),
          residency: list("residency"),
          gpa: gpa ? Number(gpa) : null,
        }),
      "Matching profile saved locally.",
    );
  };

  const previewWriting = async () => {
    if (!draft) return;
    setBusy(true);
    setMessage("");
    try {
      const preview = await previewScholarshipWriting(draft.id);
      setWritingPreview(preview);
      setSelectedSnippets(preview.profileSnippets);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const requestWriting = () => {
    if (!writingPreview) return;
    void run(
      () =>
        requestScholarshipWritingFeedback({
          draftId: writingPreview.draftId,
          kinds: [
            "grammar",
            "structure",
            "specificity",
            "shortening",
            "brainstorm",
          ],
          profileSnippets: selectedSnippets,
          provider: writingPreview.provider,
          model: writingPreview.model,
          policyAcknowledged,
          consent: writingConsent,
        }),
      "Reviewable writing suggestions are ready. Nothing was applied automatically.",
    );
  };

  if (!workspace && !message)
    return (
      <div className="content scholarship-center">
        <div className="scholarship-panel" aria-busy="true">
          Loading Scholarship Center…
        </div>
      </div>
    );

  return (
    <div className="content scholarship-center">
      <div className="page-head scholarship-hero">
        <div>
          <p className="eyebrow">Funding workspace</p>
          <h1>Scholarships</h1>
          <p>
            Find credible opportunities, organize applications, and write from
            your own experience.
          </p>
        </div>
        <div className="scholarship-privacy">
          <ShieldCheck />
          <span>
            <strong>Local and student-controlled</strong>
            <small>Coqui never submits an application.</small>
          </span>
        </div>
      </div>
      <nav className="scholarship-tabs" aria-label="Scholarship sections">
        {(
          [
            ["discover", "Discover", Search],
            ["saved", "Saved", LibraryBig],
            ["applications", "Applications", Award],
            ["writing", "Writing", FilePenLine],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            className={section === id ? "active" : ""}
            onClick={() => setSection(id)}
          >
            <Icon />
            {label}
          </button>
        ))}
      </nav>
      {message && (
        <div className="scholarship-message" role="status">
          {message}
        </div>
      )}
      {Boolean(workspace?.diffs.length) && (
        <section
          className="scholarship-diffs"
          aria-label="Scholarship source changes"
        >
          <div>
            <AlertTriangle />
            <span>
              <strong>
                {workspace!.diffs.length} source change
                {workspace!.diffs.length === 1 ? "" : "s"} need review
              </strong>
              <small>Saved notes and application state were preserved.</small>
            </span>
          </div>
          {workspace!.diffs.map((diff) => (
            <button
              key={diff.id}
              className="outline"
              disabled={busy}
              onClick={() =>
                void run(
                  () => resolveScholarshipDiff(diff.id),
                  "Source change acknowledged.",
                )
              }
            >
              Acknowledge{" "}
              {diff.kind === "missing_from_source"
                ? "missing listing"
                : "updated details"}
            </button>
          ))}
        </section>
      )}

      <AnimatedContent className="scholarship-section" key={section}>
        {section === "discover" && (
          <DiscoverSection
            workspace={workspace}
            discovered={discovered}
            busy={busy}
            title={title}
            provider={provider}
            url={url}
            deadline={deadline}
            setTitle={setTitle}
            setProvider={setProvider}
            setUrl={setUrl}
            setDeadline={setDeadline}
            addManual={addManual}
            run={run}
          />
        )}
        {section === "saved" && (
          <SavedSection
            workspace={workspace}
            opportunities={opportunities}
            active={active}
            match={match}
            query={query}
            busy={busy}
            profileOpen={profileOpen}
            setQuery={setQuery}
            setSelected={setSelected}
            setProfileOpen={setProfileOpen}
            updateProfile={updateProfile}
            run={run}
          />
        )}
        {section === "applications" && (
          <ApplicationsSection
            workspace={workspace}
            active={active}
            busy={busy}
            startApplication={startApplication}
            updateApplication={updateApplication}
            run={run}
          />
        )}
        {section === "writing" && (
          <WritingSection
            workspace={workspace}
            opportunities={opportunities}
            active={active}
            prompts={prompts}
            currentPrompt={currentPrompt}
            promptId={promptId}
            setPromptId={setPromptId}
            setSelected={setSelected}
            storyTitle={storyTitle}
            storyDetail={storyDetail}
            storyTags={storyTags}
            setStoryTitle={setStoryTitle}
            setStoryDetail={setStoryDetail}
            setStoryTags={setStoryTags}
            addStory={addStory}
            draft={draft}
            draftText={draftText}
            outline={outline}
            setDraftText={setDraftText}
            setOutline={setOutline}
            wordCount={wordCount}
            autosaveState={autosaveState}
            busy={busy}
            saveDraftVersion={saveDraftVersion}
            startApplication={startApplication}
            writingPreview={writingPreview}
            setWritingPreview={setWritingPreview}
            writingConsent={writingConsent}
            setWritingConsent={setWritingConsent}
            policyAcknowledged={policyAcknowledged}
            setPolicyAcknowledged={setPolicyAcknowledged}
            selectedSnippets={selectedSnippets}
            setSelectedSnippets={setSelectedSnippets}
            previewWriting={previewWriting}
            requestWriting={requestWriting}
            setMessage={setMessage}
            run={run}
          />
        )}
      </AnimatedContent>
    </div>
  );
}

type RunAction = (
  action: () => Promise<ScholarshipWorkspace>,
  success: string,
) => Promise<void>;

function DiscoverSection({
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
  run: RunAction;
}) {
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
                    {source.lastFetchedAt
                      ? `Last checked ${new Date(source.lastFetchedAt).toLocaleString()}`
                      : source.status === "disabled"
                        ? (source.lastError ??
                          "Open this source to search manually")
                        : "Not checked yet"}
                  </small>
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
                      Weekly
                    </label>
                  )}
                </span>
                <div>
                  <a
                    href={source.origin}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${source.name}`}
                  >
                    <ExternalLink />
                  </a>
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
            {discovered.map((item) => (
              <article key={item.id}>
                <span>
                  <strong>{item.title}</strong>
                  <small>
                    {item.awardMaximum
                      ? `Up to $${item.awardMaximum.toLocaleString()}`
                      : "Award varies"}{" "}
                    · {item.deadlineLabel || "Deadline not published"}
                  </small>
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
            ))}
          </div>
        )}
      </section>
      <section className="scholarship-panel">
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

function SavedSection({
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
  run: RunAction;
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
          <Empty
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
              <Evidence
                title="Does not currently match"
                items={match.ineligible}
                tone="danger"
              />
            )}
            {match.matched.length > 0 && (
              <Evidence
                title="Matches"
                items={match.matched.map(
                  (item) =>
                    `${item.attribute}: ${item.profileValue} (${item.requirement})`,
                )}
                tone="success"
              />
            )}
            <Evidence title="Still unknown" items={match.unknown} />
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
  run: RunAction;
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

function ApplicationsSection({
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
  run: RunAction;
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
        <Empty
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

function WritingSection(props: {
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
  run: RunAction;
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

function Empty({
  icon,
  title,
  copy,
}: {
  icon: ReactNode;
  title: string;
  copy: string;
}) {
  return (
    <div className="empty-state scholarship-empty">
      {icon}
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  );
}
function Evidence({
  title,
  items,
  tone = "neutral",
}: {
  title: string;
  items: string[];
  tone?: "neutral" | "success" | "danger";
}) {
  return (
    <section className={`match-group ${tone}`}>
      <h4>{title}</h4>
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>Nothing to report.</p>
      )}
    </section>
  );
}
