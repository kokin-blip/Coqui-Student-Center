import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Award,
  FilePenLine,
  LibraryBig,
  Search,
  ShieldCheck,
} from "lucide-react";
import {
  autosaveScholarshipDraft,
  getScholarshipWorkspace,
  previewScholarshipWriting,
  requestScholarshipWritingFeedback,
  resolveScholarshipDiff,
  saveScholarshipApplication,
  saveScholarshipDraft,
  saveScholarshipOpportunity,
  saveScholarshipProfile,
  saveScholarshipStory,
} from "../native";
import type {
  ScholarshipDraft,
  ScholarshipOpportunity,
  ScholarshipStoryExample,
  ScholarshipWorkspace,
  ScholarshipWritingPreview,
} from "../native";
import { AnimatedContent } from "./ui/CoquiPrimitives";
import "../features/scholarships/scholarships.css";
import { DiscoverSection } from "../features/scholarships/ScholarshipDiscover";
import { SavedSection } from "../features/scholarships/ScholarshipSaved";
import { ApplicationsSection } from "../features/scholarships/ScholarshipApplications";
import { WritingSection } from "../features/scholarships/ScholarshipWriting";

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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      setWorkspace(await getScholarshipWorkspace());
    } catch (error) {
      setLoadError(String(error));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
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

  if (loading)
    return (
      <div className="content scholarship-center">
        <div className="scholarship-panel scholarship-loading" aria-busy="true">
          <div className="skeleton-line wide" />
          <div className="skeleton-line" />
          <div className="skeleton-block" />
        </div>
      </div>
    );

  if (!workspace)
    return (
      <div className="content scholarship-center">
        <div className="scholarship-panel scholarship-load-error" role="alert">
          <h1>Scholarships could not load</h1>
          <p>{loadError}</p>
          <button className="outline" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </div>
    );

  return (
    <div className="content scholarship-center" data-route="scholarships">
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
            aria-pressed={section === id}
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
