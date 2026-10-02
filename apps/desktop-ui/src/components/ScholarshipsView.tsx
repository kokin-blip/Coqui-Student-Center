import { SensitiveEligibilityFields } from "../features/scholarships/SensitiveEligibilityFields";
import { FundingSearchAssistant } from "../features/scholarships/FundingSearchAssistant";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  listAiProviders,
  previewScholarshipWriting,
  requestScholarshipWritingFeedback,
  resolveScholarshipDiff,
  requestFundingProfileProposal,
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
  FundingProfileProposal,
  AiProviderStatus,
} from "../native";
import { AnimatedContent } from "./ui/CoquiPrimitives";
import "../features/scholarships/scholarships.css";
import { DiscoverSection } from "../features/scholarships/ScholarshipDiscover";
import { SavedSection } from "../features/scholarships/ScholarshipSaved";
import { ApplicationsSection } from "../features/scholarships/ScholarshipApplications";
import { WritingSection } from "../features/scholarships/ScholarshipWriting";

type Section = "search" | "discover" | "saved" | "applications" | "writing";
type AutosaveState = "idle" | "saving" | "saved" | "error";

export function ScholarshipsView() {
  const [section, setSection] = useState<Section>("discover");
  const [workspace, setWorkspace] = useState<ScholarshipWorkspace | null>(null);
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
  const profileFormRef = useRef<HTMLFormElement>(null);
  const [fundingMode, setFundingMode] = useState<"manual" | "ai">("manual");
  const [fundingInterview, setFundingInterview] = useState("");
  const [fundingConsent, setFundingConsent] = useState(false);
  const [fundingProposal, setFundingProposal] = useState<FundingProfileProposal | null>(null);
  const [fundingAiBusy, setFundingAiBusy] = useState(false);
  const [fundingAiError, setFundingAiError] = useState("");
  const [fundingAiProvider, setFundingAiProvider] = useState<AiProviderStatus | null>(null);
  const [proposalApplied, setProposalApplied] = useState(false);

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
  useEffect(() => {
    if (fundingMode !== "ai") return;
    void listAiProviders().then((items) => { setFundingAiProvider(items.find((item) => item.connected && item.healthy) ?? null); setFundingConsent(false); }).catch((error) => setFundingAiError(String(error)));
  }, [fundingMode]);
  const opportunities = useMemo(
    () =>
      workspace?.opportunities.filter((item) => item.state !== "discovered") ?? [],
    [workspace],
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
    const current = workspace?.profile;
    const hasField = (name: string) => form.elements.namedItem(name) !== null;
    void run(
      () =>
        saveScholarshipProfile({
          ...current,
          studyLevel: String(data.get("studyLevel") ?? "").trim(),
          fieldsOfStudy: list("fieldsOfStudy"),
          locations: list("locations"),
          citizenship: list("citizenship"),
          residency: list("residency"),
          culturalBackground: list("culturalBackground"),
          religion: list("religion"),
          affiliations: list("affiliations"),
          preferNotToSay: data.getAll("preferNotToSay").map(String),
          gpa: gpa ? Number(gpa) : null,
          school: hasField("school") ? String(data.get("school") ?? "").trim() : current?.school ?? "",
          degree: hasField("degree") ? String(data.get("degree") ?? "").trim() : current?.degree ?? "",
          academicYear: hasField("academicYear") ? String(data.get("academicYear") ?? "").trim() : current?.academicYear ?? "",
          interests: hasField("interests") ? list("interests") : current?.interests ?? [],
          preferredOpportunityTypes: hasField("opportunityTypes") ? [...data.getAll("opportunityTypes")].map(String) : current?.preferredOpportunityTypes ?? [],
          awardMinimum: hasField("awardMinimum") ? Number(data.get("awardMinimum") || 0) || null : current?.awardMinimum ?? null,
          deadlineToleranceDays: hasField("deadlineToleranceDays") ? Number(data.get("deadlineToleranceDays") || 0) || null : current?.deadlineToleranceDays ?? null,
          notificationsEnabled: data.get("notificationsEnabled") === "on",
        }),
      "Funding profile saved locally.",
    );
  };

  const applyFundingProposal = () => {
    const form = profileFormRef.current;
    if (!form || !fundingProposal) return;
    for (const suggestion of fundingProposal.suggestions) {
      if (suggestion.field === "preferredOpportunityTypes") {
        const value = suggestion.quote.toLowerCase().trim().replaceAll(/\s+/g, "_");
        const option = [...form.querySelectorAll<HTMLInputElement>('input[name="opportunityTypes"]')].find((item) => item.value === value);
        if (option) option.checked = true;
        continue;
      }
      const field = form.elements.namedItem(suggestion.field) as HTMLInputElement | HTMLSelectElement | null;
      if (!field) continue;
      if (suggestion.field === "studyLevel") {
        if ([...field.querySelectorAll("option")].some((option) => option.value === suggestion.quote.toLowerCase())) field.value = suggestion.quote.toLowerCase();
      } else if (["fieldsOfStudy", "locations", "interests"].includes(suggestion.field)) {
        const values = field.value.split(",").map((value) => value.trim()).filter(Boolean);
        if (!values.some((value) => value.toLowerCase() === suggestion.quote.toLowerCase())) values.push(suggestion.quote);
        field.value = values.join(", ");
      } else if (!field.value.trim()) field.value = suggestion.quote;
    }
    setProposalApplied(true);
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

  const profileReady = Boolean(
    workspace.profile.studyLevel || workspace.profile.fieldsOfStudy.length || workspace.profile.school,
  );
  if (!profileReady)
    return (
      <div className="content scholarship-center" data-route="scholarships">
        <div className="page-head scholarship-hero"><div><h1>Find funding that fits you</h1><p>Build a private matching profile for scholarships, grants, fellowships, stipends, awards, emergency funds, and other student funding.</p></div><div className="scholarship-privacy"><ShieldCheck /><span><strong>Matched on this device</strong><small>Your profile is never sent to catalog sources.</small></span></div></div>
        <form ref={profileFormRef} className="scholarship-panel funding-onboarding" onSubmit={(event) => { event.preventDefault(); updateProfile(event.currentTarget); }}>
          <div className="section-head"><div><h2>Your funding profile</h2><p>Start with the basics. Sensitive details stay optional and are never inferred.</p></div></div>
          <div className="funding-mode-choice" role="group" aria-label="How to build your funding profile"><button type="button" className={fundingMode === "manual" ? "outline active" : "outline"} aria-pressed={fundingMode === "manual"} onClick={() => setFundingMode("manual")}>Enter details myself</button><button type="button" className={fundingMode === "ai" ? "outline active" : "outline"} aria-pressed={fundingMode === "ai"} onClick={() => setFundingMode("ai")}>Help me organize my details with AI</button></div>
          {fundingMode === "ai" && <section className="funding-ai-panel" aria-label="AI-guided funding profile">
            <p>Tell Coqui only what you want to share about your school, program, year, interests, or preferred funding types. AI extracts literal quotes into a draft; it cannot decide eligibility or fill sensitive fields.</p>
            <label className="field">What should funding searches know about you?<textarea rows={4} value={fundingInterview} onChange={(event) => setFundingInterview(event.target.value)} placeholder="I study computer science at Arizona State University and am interested in public service grants…" /></label>
            <label className="confirm-row"><input type="checkbox" checked={fundingConsent} onChange={(event) => setFundingConsent(event.target.checked)} /><span><strong>Send only this description to {fundingAiProvider?.provider ?? "a connected AI provider"}</strong><small>No saved funding profile, academic records, or documents are included. {fundingAiProvider ? <a href={fundingAiProvider.disclosureUrl} target="_blank" rel="noreferrer">Read the provider’s data policy</a> : "Connect a BYOK provider in Settings first."}</small></span></label>
            <button type="button" className="outline" disabled={fundingAiBusy || !fundingAiProvider || !fundingConsent || fundingInterview.trim().length < 20} onClick={async () => { setFundingAiBusy(true); setFundingAiError(""); setProposalApplied(false); try { setFundingProposal(await requestFundingProfileProposal(fundingInterview.trim(), true, fundingAiProvider!.provider)); setFundingInterview(""); } catch (error) { setFundingAiError(String(error)); } finally { setFundingConsent(false); setFundingAiBusy(false); } }}>{fundingAiBusy ? "Preparing draft…" : "Create review draft"}</button>
            {fundingAiError && <p role="alert">{fundingAiError} You can continue manually.</p>}
            {fundingProposal && <div className="funding-ai-review" role="status"><strong>Review before saving</strong>{fundingProposal.suggestions.length ? <><ul>{fundingProposal.suggestions.map((item, index) => <li key={`${item.field}-${index}`}><strong>{item.field.replaceAll(/([A-Z])/g, " $1")}:</strong> “{item.quote}”</li>)}</ul><button type="button" className="outline" onClick={applyFundingProposal}>Apply suggestions to editable fields</button></> : <p>No details were extracted. Fill the form manually.</p>}{proposalApplied && <p>Draft fields updated. Edit anything below, then save when ready.</p>}</div>}
          </section>}
          <div className="form-grid"><label className="field">School<input name="school" placeholder="Arizona State University" /></label><label className="field">Degree or program<input name="degree" placeholder="BS, Certificate, Graduate program" /></label><label className="field">Major or fields of study<input name="fieldsOfStudy" placeholder="Computer science, Design" required /></label><label className="field">Year in school<input name="academicYear" placeholder="Sophomore" /></label><label className="field">Study level<select name="studyLevel" defaultValue="undergraduate"><option value="undergraduate">Undergraduate</option><option value="graduate">Graduate</option><option value="certificate">Certificate</option><option value="other">Other</option></select></label><label className="field">GPA (optional)<input name="gpa" type="number" min="0" max="5" step="0.01" /></label><label className="field">Location or residency region<input name="locations" placeholder="Arizona, United States" /></label><label className="field">Interests<input name="interests" placeholder="Accessibility, climate, public service" /></label><label className="field">Minimum award<input name="awardMinimum" type="number" min="0" step="100" placeholder="500" /></label><label className="field">Minimum preparation time (days)<input name="deadlineToleranceDays" type="number" min="1" max="365" placeholder="e.g. 30" /></label></div>
          <p className="field-help">Interests and preparation time affect Best Match order only. Opportunities with shorter deadlines remain visible.</p>
          <fieldset className="setup-fieldset"><legend>Opportunity types</legend><div className="course-chip-list">{["Scholarships","Grants","Fellowships","Stipends","Awards","Emergency funds","Tuition assistance","Research funding","Internship stipends","Competitions"].map((label) => <label key={label}><input type="checkbox" name="opportunityTypes" value={label.toLowerCase().replaceAll(" ", "_")} defaultChecked={label === "Scholarships" || label === "Grants"} />{label}</label>)}</div></fieldset>
          <SensitiveEligibilityFields profile={workspace.profile} />
          <details><summary>Optional sensitive eligibility details</summary><p className="field-help">Citizenship, residency, and financial-need details can improve eligibility checks, but only add what you are comfortable storing locally.</p><div className="form-grid"><label className="field">Citizenship<input name="citizenship" /></label><label className="field">Residency<input name="residency" /></label></div></details>
          <label className="confirm-row"><input type="checkbox" name="notificationsEnabled" /><span><strong>Notify me about strong matches and deadlines</strong><small>Notifications are device-local and can be changed later.</small></span></label>
          <button className="solid" disabled={busy}><Search /> Start finding funding</button>
          {message && <p role="status">{message}</p>}
        </form>
      </div>
    );

  return (
    <div className="content scholarship-center" data-route="scholarships">
      <div className="page-head scholarship-hero">
        <div>
          <p className="eyebrow">Funding workspace</p>
          <h1>Funding</h1>
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
      <nav className="scholarship-tabs" aria-label="Funding sections">
        {(
          [
            ["discover", "Discover", Search],
            ["search", "Search assistant", Search],
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
        {section === "search" && workspace && <FundingSearchAssistant workspace={workspace} busy={busy} run={run} onWrite={id=>{setSelected(id);setSection("writing");}} />}
        {section === "saved" && (
          <SavedSection
            workspace={workspace}
            opportunities={opportunities}
            active={active}
            busy={busy}
            profileOpen={profileOpen}
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
