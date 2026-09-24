import { useEffect, useMemo, useState } from "react";
import { ExternalLink, FileUp, ImageUp, Sparkles } from "lucide-react";
import {
  discoverAsuRoadmaps, getDashboard, getPlannerProfile, getSemesterAnalysisReports, getSemesterRoadmaps, importDocumentBytes,
  importDocumentPath, isDesktop, listenForFileDrops, listAiProviders, pastedScheduleImage,
  previewAsuRoadmap, previewRoadmapFile, requestSemesterScheduleAnalysis, savePlannerProfile,
  saveSemesterAnalysisReport, saveSemesterRoadmap,
  type AcademicTermRecord, type AiProviderStatus, type AnalysisReport, type Dashboard, type PlannerProfile,
  type RoadmapDiscoveryMatch, type RoadmapEvidence, type RoadmapPreview, type SemesterScenario, type SemesterScenarioSection, type WorkspaceSnapshot,
} from "../../native";
import { analyzeSemesterSchedule } from "./scheduleAnalysis";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hours = (value: number) => `${(value / 60).toFixed(1)} h`;
const fingerprint = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
const emptyProfile: PlannerProfile = { program: "", catalogYear: "", studyGoals: "", careerInterests: "", constraints: "", version: 0 };

function importedSections(dashboard: Dashboard, before: Set<string>, workspace: WorkspaceSnapshot): SemesterScenarioSection[] {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return dashboard.candidates.filter((candidate) => !before.has(candidate.id) && candidate.kind === "class_meeting" && candidate.status === "pending")
    .map((candidate) => {
      const course = workspace.courses.find((item) => normalize(item.code) === normalize(candidate.course) || normalize(item.title) === normalize(candidate.course));
      return { id: crypto.randomUUID(), courseId: course?.id ?? "", importedCourseLabel: candidate.course || candidate.title,
        weekdays: candidate.weekdays ?? [], startsAtLocal: candidate.startsAtLocal || "", endsAtLocal: candidate.endsAtLocal || "",
        location: candidate.location ?? "", modality: candidate.modality === "in-person" ? "in_person" : candidate.modality === "online" || candidate.modality === "hybrid" ? candidate.modality : "unknown" };
    });
}

export function SemesterScheduleAnalysisView({ workspace, term, scenario, onScenarioFromScreenshot }: {
  workspace: WorkspaceSnapshot; term: AcademicTermRecord; scenario: SemesterScenario | null;
  onScenarioFromScreenshot: (scenario: SemesterScenario) => void;
}) {
  const [profile, setProfile] = useState<PlannerProfile>(emptyProfile);
  const [savedProfile, setSavedProfile] = useState<PlannerProfile>(emptyProfile);
  const [roadmaps, setRoadmaps] = useState<RoadmapEvidence[]>([]);
  const [reports, setReports] = useState<AnalysisReport[]>([]);
  const [roadmapId, setRoadmapId] = useState("");
  const [roadmapUrl, setRoadmapUrl] = useState("");
  const [discovered, setDiscovered] = useState<RoadmapDiscoveryMatch[]>([]);
  const [manualExcerpt, setManualExcerpt] = useState("");
  const [preview, setPreview] = useState<RoadmapPreview | null>(null);
  const [providers, setProviders] = useState<AiProviderStatus[]>([]);
  const [consent, setConsent] = useState(false);
  const [includeRatings, setIncludeRatings] = useState(false);
  const [ratingEvidence, setRatingEvidence] = useState("");
  const [hasScreenshot, setHasScreenshot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [activeReport, setActiveReport] = useState<AnalysisReport | null>(null);
  const [currentFingerprint, setCurrentFingerprint] = useState("");

  useEffect(() => {
    void Promise.all([getPlannerProfile(), getSemesterRoadmaps(), getSemesterAnalysisReports(), listAiProviders()])
      .then(([nextProfile, nextRoadmaps, nextReports, nextProviders]) => { setProfile(nextProfile); setSavedProfile(nextProfile); setRoadmaps(nextRoadmaps); setReports(nextReports); setProviders(nextProviders); })
      .catch((reason) => setError(`Planner analysis data could not be loaded: ${String(reason)}`));
  }, []);

  const importScreenshot = async (file: File | string) => {
    setBusy(true); setError(""); setNotice("");
    try {
      if (typeof file !== "string" && !["image/png", "image/jpeg", "application/pdf"].includes(file.type) && !/\.(png|jpe?g|pdf)$/i.test(file.name)) throw new Error("Use a PNG, JPEG, or PDF schedule.");
      const before = new Set((await getDashboard()).candidates.map((candidate) => candidate.id));
      const next = typeof file === "string" ? await importDocumentPath(file) : await importDocumentBytes(file.name || "schedule.png", new Uint8Array(await file.arrayBuffer()));
      const sections = importedSections(next, before, workspace);
      if (!sections.length) { setError("No class times were found. Try a clearer schedule or add sections manually. The source remains pending for review."); return; }
      onScenarioFromScreenshot({ id: crypto.randomUUID(), termId: term.id, name: "Screenshot schedule idea", sections, version: 0 });
      setHasScreenshot(true); setIncludeRatings(false); setRatingEvidence(""); setConsent(false);
      setNotice(`${sections.length} class${sections.length === 1 ? "" : "es"} extracted into an unsaved idea. Review course matches, days, and times below before saving. Your enrolled schedule did not change.`);
    } catch (reason) { setError(`Schedule could not be read: ${String(reason)}`); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!isDesktop()) return;
    const onPaste = (event: ClipboardEvent) => { const image = pastedScheduleImage(event); if (image) { event.preventDefault(); void importScreenshot(image); } };
    window.addEventListener("paste", onPaste);
    let active = true; let remove = () => {};
    void listenForFileDrops((paths) => { const path = paths.find((value) => /\.(png|jpe?g|pdf)$/i.test(value)); if (path) void importScreenshot(path); }).then((stop) => { if (active) remove = stop; else stop(); });
    return () => { active = false; remove(); window.removeEventListener("paste", onPaste); };
  }, [term.id, workspace]);

  const meetings = useMemo<SemesterScenarioSection[]>(() => scenario?.sections ?? workspace.classMeetings.filter((meeting) => meeting.termId === term.id).map((meeting) => ({ ...meeting, modality: (["in_person", "online", "hybrid"].includes(meeting.modality) ? meeting.modality : "unknown") as SemesterScenarioSection["modality"] })), [scenario, workspace, term.id]);
  const analysis = useMemo(() => analyzeSemesterSchedule(meetings, workspace.rhythmRules, workspace.availability, term, workspace.preferences, workspace.tasks, workspace.commitments, workspace.profile?.timezone ?? "UTC"), [meetings, workspace, term]);
  const scenarioKey = scenario?.id ?? `current:${term.id}`;
  const input = { scenarioKey, sections: meetings, rhythmRules: workspace.rhythmRules, commitments: workspace.commitments, availability: workspace.availability, preferences: workspace.preferences, tasks: workspace.tasks.filter((task) => !task.completed).map((task) => ({ courseId: task.courseId, dueAt: task.dueAt, minutes: task.minutes })), profile, roadmap: roadmaps.find((item) => item.id === roadmapId) ?? null, analysis };
  const inputJson = JSON.stringify(input);
  const profileDirty = JSON.stringify(profile) !== JSON.stringify(savedProfile);
  useEffect(() => { let active = true; void fingerprint(inputJson).then((value) => { if (active) setCurrentFingerprint(value); }); return () => { active = false; }; }, [inputJson]);
  useEffect(() => { setActiveReport(reports.find((item) => item.scenarioKey === scenarioKey) ?? null); }, [scenarioKey, reports]);
  const selectedProvider = providers.find((provider) => provider.connected && provider.healthy);
  const savedFacts = useMemo(() => { try { return activeReport ? JSON.parse(activeReport.factsJson) as { analysis?: { warnings?: string[]; weeklyStudyMinutes?: number | null; weeklyKnownEffortMinutes?: number }; screenshotRating?: string } : null; } catch { return null; } }, [activeReport]);
  const saveProfile = async () => { setBusy(true); setError(""); try { const saved = await savePlannerProfile(profile); setProfile(saved); setSavedProfile(saved); setNotice("Planner goals saved locally."); } catch (reason) { setError(String(reason)); } finally { setBusy(false); } };
  const previewUrl = async () => { setBusy(true); setError(""); try {
    if (workspace.institution?.id === "104151") setPreview(await previewAsuRoadmap(roadmapUrl, profile.program, profile.catalogYear));
    else if (/^https:\/\//i.test(roadmapUrl) && manualExcerpt.trim().length >= 20) setPreview({ institutionId: workspace.institution?.id ?? "", program: profile.program, catalogYear: profile.catalogYear, sourceUrl: roadmapUrl, sourceLabel: "Student-provided roadmap link", format: "unknown", excerpt: manualExcerpt.trim(), fetchedAt: new Date().toISOString() });
    else throw new Error("Enter an HTTPS link and paste the relevant roadmap text for review.");
  } catch (reason) { setError(String(reason)); } finally { setBusy(false); } };
  const discover = async () => { setBusy(true); setError(""); setDiscovered([]); try { const matches = await discoverAsuRoadmaps(profile.program, profile.catalogYear); setDiscovered(matches); if (!matches.length) setNotice("No ASU undergraduate program matched. Check the name or paste an official roadmap URL."); } catch (reason) { setError(String(reason)); } finally { setBusy(false); } };
  const previewFile = async (file: File) => { setBusy(true); setError(""); try { setPreview(await previewRoadmapFile(file, profile.program, profile.catalogYear, workspace.institution?.id ?? "")); } catch (reason) { setError(String(reason)); } finally { setBusy(false); } };
  const approveRoadmap = async () => { if (!preview) return; setBusy(true); setError(""); try { const next = await saveSemesterRoadmap(preview); setRoadmaps(next); setRoadmapId(next.at(-1)?.id ?? ""); setPreview(null); setNotice("Roadmap evidence approved and saved locally."); } catch (reason) { setError(String(reason)); } finally { setBusy(false); } };
  const runAnalysis = async (withAi: boolean) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const inputFingerprint = await fingerprint(inputJson);
      const aiFacts = { schedule: meetings.map(({ courseId, importedCourseLabel, weekdays, startsAtLocal, endsAtLocal, modality }) => ({ courseId, courseCode: workspace.courses.find((course) => course.id === courseId)?.code ?? importedCourseLabel ?? "unmatched", weekdays, startsAtLocal, endsAtLocal, modality })), rhythm: workspace.rhythmRules.map(({ kind, weekday, startsAtLocal, endsAtLocal }) => ({ kind, weekday, startsAtLocal, endsAtLocal })), analysis };
      const aiFactsJson = JSON.stringify(aiFacts);
      const factsJson = JSON.stringify({ ...aiFacts, screenshotRating: withAi && hasScreenshot && includeRatings ? ratingEvidence.trim() : undefined });
      let findings: AnalysisReport["aiFindings"] = []; let provider = ""; let model = "";
      if (withAi) {
        if (!selectedProvider || !consent) throw new Error("Connect an AI provider and consent to the displayed data scope first.");
        if (profileDirty) throw new Error("Save your planner goals before asking AI to use them.");
        const response = await requestSemesterScheduleAnalysis({ factsJson: aiFactsJson, roadmapId: roadmapId || undefined, includeRatings: hasScreenshot && includeRatings, ratingEvidence: hasScreenshot && includeRatings ? ratingEvidence.trim() : "", consent, expectedProvider: selectedProvider.provider });
        findings = response.findings; provider = response.provider; model = response.model;
        setConsent(false);
      }
      const report: AnalysisReport = { id: "", scenarioKey, inputFingerprint, generatedAt: new Date().toISOString(), factsJson, aiFindings: findings, provider, model, version: 0 };
      const next = await saveSemesterAnalysisReport(report); setReports(next); setActiveReport(next[0] ?? report);
      setNotice(withAi ? "Analysis saved locally. Your schedule was not changed." : "Offline analysis saved locally. Your schedule was not changed.");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  return <section className="workspace-panel semester-analysis" aria-labelledby="semester-analysis-title">
    <div className="section-head"><div><h2 id="semester-analysis-title">Will this schedule work for your week?</h2><p>Analyze {scenario ? `“${scenario.name}”` : "your current schedule"} against your rhythm, commitments, and goals. Nothing here changes enrollment.</p></div></div>
    <div className={`semester-analysis-drop ${dragging ? "dragging" : ""}`} onDragOver={(event) => event.preventDefault()} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) void importScreenshot(file); }}>
      <ImageUp aria-hidden="true"/><strong>Drop a schedule screenshot or PDF</strong><span>Or paste a screenshot with Ctrl/Cmd+V. Extracted classes become an unsaved idea for review.</span>
      <label className="outline schedule-file-button">Choose a schedule<input type="file" accept="image/png,image/jpeg,application/pdf" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importScreenshot(file); }}/></label>
    </div>
    <div className="semester-analysis-facts"><h3>Week fit</h3>{!meetings.length ? <p>Add classes or drop a schedule to see a comparison.</p> : <>
      {analysis.warnings.length ? <ul>{analysis.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <p>No conflicts detected in the information available. This is not a guarantee that the week will feel manageable.</p>}
      <div className="semester-analysis-metrics"><span>Preferred sleep window <strong>{analysis.preferredSleepMinutes === null ? "Unknown" : hours(analysis.preferredSleepMinutes)}</strong></span><span>Study capacity <strong>{analysis.weeklyStudyMinutes === null ? "Unknown" : `${hours(analysis.weeklyStudyMinutes)} / week`}</strong></span><span>Known assignment effort <strong>{hours(analysis.weeklyKnownEffortMinutes)} / week</strong></span><span>Potential overload <strong>{analysis.overloadMinutes === null ? "Unknown" : hours(analysis.overloadMinutes)}</strong></span></div>
      <div className="semester-analysis-days">{analysis.days.map((day) => <div key={day.weekday}><strong>{weekdays[day.weekday]}</strong><span>Class {hours(day.classMinutes)} · Commute {hours(day.commuteMinutes)} · Study {day.studyMinutes === null ? "?" : hours(day.studyMinutes)}</span>{day.classConflictMinutes + day.rhythmConflictMinutes + day.sleepConflictMinutes + day.commuteConflictMinutes > 0 && <small>Conflicts: class {hours(day.classConflictMinutes)}, rhythm {hours(day.rhythmConflictMinutes)}, sleep {hours(day.sleepConflictMinutes)}, commute {hours(day.commuteConflictMinutes)}</small>}{day.missingMealWindows > 0 && <small>Less than 30 minutes free in a usual lunch or dinner window</small>}</div>)}</div>
      {analysis.missingInputs.length > 0 && <p className="source-note">Missing information: {analysis.missingInputs.join(", ")}. Capacity may be underestimated.</p>}
      <button className="outline" disabled={busy} onClick={() => void runAnalysis(false)}>Save offline analysis</button>
    </>}</div>
    <details className="semester-analysis-details"><summary>Degree roadmap and personal goals</summary><div className="semester-analysis-form">
      <label className="field">Degree program<input value={profile.program} maxLength={160} onChange={(event) => setProfile({ ...profile, program: event.target.value })}/></label>
      <label className="field">Catalog year<input value={profile.catalogYear} inputMode="numeric" maxLength={4} placeholder="2026" onChange={(event) => setProfile({ ...profile, catalogYear: event.target.value })}/></label>
      <label className="field">Study goals<textarea value={profile.studyGoals} maxLength={2000} onChange={(event) => setProfile({ ...profile, studyGoals: event.target.value })}/></label>
      <label className="field">Career interests<textarea value={profile.careerInterests} maxLength={2000} onChange={(event) => setProfile({ ...profile, careerInterests: event.target.value })}/></label>
      <label className="field">Relevant constraints<textarea value={profile.constraints} maxLength={2000} onChange={(event) => setProfile({ ...profile, constraints: event.target.value })}/></label>
      <button className="outline" disabled={busy} onClick={() => void saveProfile()}>Save goals locally</button>
      <label className="field">Approved roadmap<select value={roadmapId} onChange={(event) => setRoadmapId(event.target.value)}><option value="">None selected</option>{roadmaps.map((item) => <option value={item.id} key={item.id}>{item.program} · {item.catalogYear} · {item.sourceLabel}</option>)}</select></label>
      <label className="field">Roadmap link<input type="url" value={roadmapUrl} placeholder="https://degrees.asu.edu/…" onChange={(event) => setRoadmapUrl(event.target.value)}/></label>
      {workspace.institution?.id === "104151" && <div className="semester-roadmap-discovery"><button className="outline" disabled={busy || profile.program.trim().length < 3 || !/^\d{4}$/.test(profile.catalogYear)} onClick={() => void discover()}>Find ASU program</button>{discovered.length > 0 && <label className="field">Official ASU matches<select value="" onChange={(event) => { const match = discovered.find((item) => item.sourceUrl === event.target.value); if (match) { setRoadmapUrl(match.sourceUrl); setProfile({ ...profile, program: match.program }); setPreview(null); } }}><option value="">Choose a matching program</option>{discovered.map((item) => <option key={item.sourceUrl} value={item.sourceUrl}>{item.program} · {item.catalogYear}</option>)}</select><small>Opening a match still checks its selected catalog-year page. You will review requirements before saving.</small></label>}</div>}
      {workspace.institution?.id !== "104151" && <label className="field">Relevant text from that link<textarea value={manualExcerpt} onChange={(event) => setManualExcerpt(event.target.value)} placeholder="Paste the requirements you want Coqui to consider"/></label>}
      <div className="semester-analysis-actions"><button className="outline" disabled={busy || !roadmapUrl || !profile.program || !profile.catalogYear} onClick={() => void previewUrl()}>Review roadmap link</button><label className="outline schedule-file-button"><FileUp/> Choose roadmap file<input type="file" accept="image/png,image/jpeg,application/pdf" disabled={busy || !profile.program || !profile.catalogYear} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void previewFile(file); }}/></label>{workspace.institution?.id === "104151" && <a href="https://degrees.asu.edu/bachelors" target="_blank" rel="noreferrer">Find an ASU degree page <ExternalLink/></a>}</div>
      {preview && <div className="semester-roadmap-preview"><strong>Review before saving: {preview.sourceLabel}</strong><small>{preview.program} · catalog {preview.catalogYear} · {preview.format.replaceAll("_", " ")}</small><textarea aria-label="Roadmap evidence to approve" value={preview.excerpt} onChange={(event) => setPreview({ ...preview, excerpt: event.target.value })}/><small>{preview.sourceUrl || "Student-provided file"} · retrieved {preview.fetchedAt}</small><button className="solid" disabled={busy || preview.excerpt.trim().length < 20} onClick={() => void approveRoadmap()}>Approve roadmap evidence</button></div>}
    </div></details>
    <details className="semester-analysis-details"><summary>Optional AI interpretation</summary><div className="semester-analysis-form">
      <p>AI can explain tradeoffs against your approved roadmap and goals. It cannot verify graduation requirements or change your schedule.</p>
      <p>{selectedProvider ? <>Provider: {selectedProvider.provider} · {selectedProvider.model}. <a href={selectedProvider.disclosureUrl} target="_blank" rel="noreferrer">Data policy <ExternalLink/></a></> : "Connect and test OpenAI, Anthropic, or Gemini in Settings first. Offline analysis remains available."}</p>{profileDirty && <p>Save your edited goals before AI interpretation.</p>}
      {hasScreenshot && <div className="semester-rating-choice"><label><input type="checkbox" checked={includeRatings} onChange={(event) => setIncludeRatings(event.target.checked)}/> Consider ProfessorView ratings visible in my screenshot</label>{includeRatings && <label className="field">Rating text I can verify in the screenshot<textarea value={ratingEvidence} maxLength={1000} onChange={(event) => setRatingEvidence(event.target.value)} placeholder="e.g. Instructor name, displayed rating, review count"/><small>Unverified screenshot context only; never used to calculate week feasibility.</small></label>}</div>}
      <label className="check-row"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)}/><span>I consent to sending the reviewed schedule facts, rhythm and workload summary, saved planner goals, and selected roadmap excerpt to the provider above{hasScreenshot && includeRatings ? ", plus the rating text I entered" : ""}.</span></label>
      <button className="solid" disabled={busy || profileDirty || !selectedProvider || !consent || !meetings.length || hasScreenshot && includeRatings && !ratingEvidence.trim()} onClick={() => void runAnalysis(true)}><Sparkles/> Interpret with AI</button>
    </div></details>
    {activeReport && <div className="semester-report" role="status"><h3>Saved analysis · {new Date(activeReport.generatedAt).toLocaleString()}</h3>{currentFingerprint && currentFingerprint !== activeReport.inputFingerprint && <strong>This report is stale; its inputs changed. Run the analysis again.</strong>}{savedFacts?.analysis && <p>At the time: {savedFacts.analysis.weeklyStudyMinutes === null ? "study capacity unknown" : `${hours(savedFacts.analysis.weeklyStudyMinutes ?? 0)} of preferred study time per week`}; {hours(savedFacts.analysis.weeklyKnownEffortMinutes ?? 0)} of known assignment effort per week. {savedFacts.analysis.warnings?.join(" · ") || "No detected conflicts in known inputs."}</p>}{savedFacts?.screenshotRating && <small>Included unverified ProfessorView screenshot text: {savedFacts.screenshotRating}</small>}{activeReport.aiFindings.map((finding, index) => <article key={index}><strong>{finding.title}</strong><p>{finding.detail}</p><small>Evidence: {finding.evidenceIds.map((id, evidenceIndex) => { const roadmap = roadmaps.find((item) => item.id === id); return <span key={`${id}-${evidenceIndex}`}>{evidenceIndex > 0 ? ", " : ""}{roadmap ? roadmap.sourceUrl ? <a href={roadmap.sourceUrl} target="_blank" rel="noreferrer">{roadmap.program} roadmap</a> : `${roadmap.program} approved upload` : id.replaceAll("_", " ")}</span>; })}</small></article>)}<small>Based on the inputs saved at that time. Rerun after changing classes, rhythm, goals, or roadmap.</small></div>}
    {reports.length > 0 && <div className="semester-report-history"><strong>Earlier analyses</strong>{reports.filter((item) => item.scenarioKey === scenarioKey).slice(0, 5).map((item) => <button className="text-button" key={item.id} onClick={() => setActiveReport(item)}>{new Date(item.generatedAt).toLocaleString()} · {item.aiFindings.length ? "AI and offline" : "Offline"}</button>)}</div>}
    {notice && <p role="status" className="source-note">{notice}</p>}{error && <p role="alert" className="form-error">{error}</p>}
  </section>;
}
