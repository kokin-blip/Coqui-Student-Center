import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, GraduationCap, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { deleteSemesterScenario, getLocalWorkspace, getProfessorCatalog, getSemesterCatalogSections, getSemesterScenarios, lookupProfessorRating, upsertSemesterScenario, type ProfessorRatingSummary, type ProfessorRecord, type SemesterCatalogSection, type SemesterScenario, type SemesterScenarioSection, type WorkspaceSnapshot } from "../native";
import { compareSemester } from "../features/semester/semesterComparison";
import { SemesterScheduleAnalysisView } from "../features/semester/SemesterScheduleAnalysisView";

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hours = (value: number) => `${(value / 60).toFixed(1)} h`;

function newScenario(workspace: WorkspaceSnapshot, termId: string, copy: boolean): SemesterScenario {
  return {
    id: crypto.randomUUID(), termId, name: copy ? "Alternative to current schedule" : "New schedule idea", version: 0,
    sections: copy ? workspace.classMeetings.filter((meeting) => meeting.termId === termId).map((meeting) => ({
      id: crypto.randomUUID(), courseId: meeting.courseId, instructorId: meeting.instructorId,
      weekdays: [...meeting.weekdays], startsAtLocal: meeting.startsAtLocal, endsAtLocal: meeting.endsAtLocal,
      location: meeting.location, modality: (["in_person", "online", "hybrid"].includes(meeting.modality) ? meeting.modality : "unknown") as SemesterScenarioSection["modality"],
      rotationIntervalWeeks: meeting.rotationIntervalWeeks, rotationOffsetWeeks: meeting.rotationOffsetWeeks,
      sourceMeetingId: meeting.id,
    })) : [],
  };
}

export function SemesterPlannerView() {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [scenarios, setScenarios] = useState<SemesterScenario[]>([]);
  const [professors, setProfessors] = useState<ProfessorRecord[]>([]);
  const [ratings, setRatings] = useState<Record<string, { value: ProfessorRatingSummary | null; error?: boolean }>>({});
  const requestedRatings = useRef(new Set<string>());
  const [catalogSections, setCatalogSections] = useState<SemesterCatalogSection[]>([]);
  const [catalogChoice, setCatalogChoice] = useState("");
  const [sectionError, setSectionError] = useState("");
  const [draft, setDraft] = useState<SemesterScenario | null>(null);
  const [termId, setTermId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    void Promise.all([getLocalWorkspace(), getSemesterScenarios()]).then(([nextWorkspace, nextScenarios]) => {
      setWorkspace(nextWorkspace); setScenarios(nextScenarios);
      setTermId(nextWorkspace.terms.find((term) => term.active)?.id ?? nextWorkspace.terms[0]?.id ?? "");
    }).catch((reason) => setError(String(reason)));
    void getProfessorCatalog().then(setProfessors).catch(() => setSectionError("Instructor listings could not be loaded. You can still add sections manually."));
  }, []);
  useEffect(() => {
    if (!termId) return;
    let active = true;
    setCatalogSections([]); setCatalogChoice(""); setSectionError("");
    void getSemesterCatalogSections(termId).then((items) => { if (active) setCatalogSections(items); })
      .catch(() => { if (active) setSectionError("Catalog sections could not be loaded. You can still add a section manually."); });
    return () => { active = false; };
  }, [termId]);
  const current = useMemo(() => workspace?.classMeetings.filter((meeting) => meeting.termId === termId) ?? [], [workspace, termId]);
  const professorForCurrent = (courseId: string, instructorId: string) => {
    const instructor = workspace?.instructors.find((item) => item.id === instructorId);
    return professors.find((item) => item.id === `local:${instructorId}` || item.courseId === courseId && item.name.trim().toLowerCase() === instructor?.name.trim().toLowerCase());
  };
  useEffect(() => {
    if (workspace?.institution?.id !== "104151") return;
    const ids = [...new Set([...current.map((meeting) => meeting.instructorId ? professorForCurrent(meeting.courseId, meeting.instructorId)?.id : undefined), ...(draft?.sections.map((section) => section.professorRecordId ?? (section.instructorId ? professorForCurrent(section.courseId, section.instructorId)?.id : undefined)) ?? [])].filter((id): id is string => !!id && !requestedRatings.current.has(id)))];
    ids.forEach((id) => requestedRatings.current.add(id));
    const groups = new Map<string, string[]>();
    for (const id of ids) { const professor = professors.find((item) => item.id === id); if (!professor) continue; const key = `${professor.name.trim().toLowerCase()}|${professor.source.campusId.toLowerCase()}`; groups.set(key, [...(groups.get(key) ?? []), id]); }
    const batches = [...groups.values()];
    let next = 0;
    const worker = async () => { while (next < batches.length) { const batch = batches[next++]; const id = batch[0]; try { const value = await lookupProfessorRating(id); setRatings((old) => ({ ...old, ...Object.fromEntries(batch.map((key) => [key, { value }])) })); } catch { setRatings((old) => ({ ...old, ...Object.fromEntries(batch.map((key) => [key, { value: null, error: true }])) })); } } };
    void Promise.all(Array.from({ length: Math.min(3, batches.length) }, worker));
  }, [current, draft, professors, workspace]);
  const retryRating = async (id: string) => {
    setRatings((old) => { const next = { ...old }; delete next[id]; return next; });
    try { const value = await lookupProfessorRating(id); setRatings((old) => ({ ...old, [id]: { value } })); }
    catch { setRatings((old) => ({ ...old, [id]: { value: null, error: true } })); }
  };
  const ratingNote = (id: string | undefined) => {
    if (!id) return null;
    const result = ratings[id];
    if (!result) return <small>Checking Rate My Professors…</small>;
    if (result.error) return <small>Ratings unavailable right now. <button className="text-button" onClick={() => void retryRating(id)}>Retry</button></small>;
    if (!result.value) return <small>No matching Rate My Professors profile found.</small>;
    return <small className="semester-rating-summary">RMP {result.value.value.toFixed(1)}/5 · {result.value.reviewCount} student reviews · <a href={result.value.sourceUrl} target="_blank" rel="noreferrer">View profile <ExternalLink /></a><span>{result.value.biasWarning} Not used to determine schedule feasibility.</span></small>;
  };
  const selectedTerm = workspace?.terms.find((term) => term.id === termId);
  const courses = useMemo(() => workspace?.courses.filter((course) => !course.termId || course.termId === termId) ?? [], [workspace, termId]);
  const baseline = selectedTerm && compareSemester(current.map((meeting) => ({ ...meeting, modality: (meeting.modality || "unknown") as SemesterScenarioSection["modality"] })), workspace?.rhythmRules ?? [], selectedTerm, workspace?.preferences?.defaultCommuteMinutes ?? 0, workspace?.tasks ?? []);
  const candidate = selectedTerm && draft && draft.sections.length > 0 && compareSemester(draft.sections, workspace?.rhythmRules ?? [], selectedTerm, workspace?.preferences?.defaultCommuteMinutes ?? 0, workspace?.tasks ?? []);
  const sectionsValid = draft?.sections.every((section) => section.weekdays.length > 0 && section.startsAtLocal < section.endsAtLocal && (section.rotationIntervalWeeks ?? 1) >= 1 && (section.rotationIntervalWeeks ?? 1) <= 8 && (section.rotationOffsetWeeks ?? 0) >= 0 && (section.rotationOffsetWeeks ?? 0) < (section.rotationIntervalWeeks ?? 1) && courses.some((course) => course.id === section.courseId) && (!section.professorRecordId || professors.some((professor) => professor.id === section.professorRecordId && professor.courseId === section.courseId && professor.source.kind === "official_course_catalog")) && (!section.catalogSectionLineNumber || catalogSections.some((item) => item.courseId === section.courseId && item.section.lineNumber === section.catalogSectionLineNumber))) ?? false;
  const updateSection = (id: string, patch: Partial<SemesterScenarioSection>) =>
    setDraft((value) => value && ({ ...value, sections: value.sections.map((section) => section.id === id ? { ...section, ...patch } : section) }));
  const addCatalogSection = () => {
    if (!draft) return;
    const item = catalogSections[Number(catalogChoice)];
    if (!item || !item.section.lineNumber || draft.sections.some((section) => section.courseId === item.courseId && section.catalogSectionLineNumber === item.section.lineNumber)) return;
    const section = item.section;
    setDraft({ ...draft, sections: [...draft.sections, {
      id: crypto.randomUUID(), courseId: item.courseId, professorRecordId: item.professorRecordId,
      catalogSectionLineNumber: section.lineNumber, weekdays: [...section.weekdays],
      startsAtLocal: section.startsAtLocal, endsAtLocal: section.endsAtLocal,
      location: section.location, modality: section.modality === "in-person" ? "in_person" : (["online", "hybrid"].includes(section.modality) ? section.modality : "unknown") as SemesterScenarioSection["modality"],
    }] });
    setCatalogChoice("");
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const updated = await upsertSemesterScenario({ ...draft, name: draft.name.trim() });
      setScenarios(updated); setDraft(updated.find((item) => item.id === draft.id) ?? null);
      setNotice("Idea saved locally. Your enrolled schedule and study plan were not changed.");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!draft || draft.version === 0 || !window.confirm(`Delete ${draft.name}? Your enrolled schedule will not change.`)) return;
    setBusy(true); setError("");
    try { setScenarios(await deleteSemesterScenario(draft.id, draft.version)); setDraft(null); setNotice("Idea deleted. Your enrolled schedule was not changed."); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  if (!workspace) return <div className="content workspace-page"><div className="loading">{error || "Loading semester options…"}</div></div>;
  return <div className="content workspace-page mode-semester" data-route="semester">
    <div className="page-head"><div><h1>Semester planner</h1><p>Try section combinations before changing your enrolled schedule. Comparisons use recurring class times and your protected weekly rhythm.</p></div></div>
    {workspace.terms.length > 0 && <label className="field semester-term">Academic term<select value={termId} onChange={(event) => { setTermId(event.target.value); setDraft(null); setNotice(""); }}>{workspace.terms.map((term) => <option key={term.id} value={term.id}>{term.name}</option>)}</select></label>}
    {!termId ? <div className="empty-state"><GraduationCap /><strong>Add an academic term first</strong><p>Create a term in Courses, then return to compare section schedules.</p></div> : <>
      <section className="workspace-panel" aria-labelledby="semester-current-title"><div className="section-head"><div><h2 id="semester-current-title">Current schedule</h2><p>{current.length} recurring meeting pattern{current.length === 1 ? "" : "s"} in this term</p></div></div>
        {current.length ? <div className="semester-section-list">{current.map((meeting) => {
          const course = workspace.courses.find((item) => item.id === meeting.courseId);
          const instructor = workspace.instructors.find((item) => item.id === meeting.instructorId);
          return <article key={meeting.id}><div className="record-icon class"><GraduationCap /></div><div><strong>{course?.code || course?.title || "Course"} · {meeting.component}</strong><small>{meeting.weekdays.map((day) => days[day]).join(" ")} · {meeting.startsAtLocal}–{meeting.endsAtLocal} · {meeting.modality || "modality unknown"}</small>{instructor && <small>Instructor: {instructor.name}</small>}{workspace.institution?.id === "104151" && instructor && ratingNote(professorForCurrent(meeting.courseId, instructor.id)?.id)}</div></article>;
        })}</div> : <p>No class meetings are imported for this term yet. You can still build a manual idea.</p>}
      </section>
      <SemesterScheduleAnalysisView workspace={workspace} term={selectedTerm!} scenario={draft} onScenarioFromScreenshot={setDraft} />
      <section className="workspace-panel" aria-labelledby="semester-ideas-title"><div className="section-head"><div><h2 id="semester-ideas-title">Schedule ideas</h2><p>Drafts stay on this device and are included in encrypted backups.</p></div></div>
        <div className="semester-scenario-actions"><button className="outline" disabled={!current.length || busy} onClick={() => { setDraft(newScenario(workspace, termId, true)); setError(""); }}>Copy current schedule</button><button className="outline" disabled={busy} onClick={() => { setDraft(newScenario(workspace, termId, false)); setError(""); }}><Plus /> Start empty idea</button></div>
        <div className="semester-scenario-list" role="group" aria-label="Saved schedule ideas">{scenarios.filter((item) => item.termId === termId).map((item) => <button key={item.id} className={draft?.id === item.id ? "active" : ""} aria-pressed={draft?.id === item.id} onClick={() => { setDraft(structuredClone(item)); setError(""); setNotice(""); }}>{item.name}<small>{item.sections.length} section{item.sections.length === 1 ? "" : "s"}</small></button>)}</div>
        {draft && <div className="semester-editor"><div className="semester-editor-head"><label className="field">Idea name<input value={draft.name} maxLength={80} onChange={(event) => setDraft({ ...draft, name: event.target.value })}/></label><div className="semester-editor-actions"><button className="solid" disabled={busy || !draft.name.trim() || !draft.sections.length || !sectionsValid} onClick={() => void save()}>Save idea</button><button className="outline" disabled={busy} onClick={() => { setDraft(null); setError(""); }}>Close</button>{draft.version > 0 && <button className="outline danger" disabled={busy} onClick={() => void remove()}><Trash2 /> Delete</button>}</div></div>
          {sectionError && <p className="form-error" role="alert">{sectionError}</p>}
          {catalogSections.length > 0 && <div className="semester-catalog-picker"><label className="field">Available catalog section<select value={catalogChoice} onChange={(event) => setCatalogChoice(event.target.value)}><option value="">Choose a listed section</option>{catalogSections.map((item, index) => <option key={`${item.courseId}-${item.section.lineNumber}-${index}`} value={index} disabled={!item.section.lineNumber || draft.sections.some((section) => section.courseId === item.courseId && section.catalogSectionLineNumber === item.section.lineNumber)}>{item.courseCode} · #{item.section.lineNumber || "unlisted"} · {item.section.weekdays.map((day) => days[day]).join(" ")} {item.section.startsAtLocal}–{item.section.endsAtLocal} · {item.section.instructor || "Instructor unlisted"}</option>)}</select></label><button className="outline" disabled={!catalogChoice || busy} onClick={addCatalogSection}>Add listed section</button><small>Review before saving; enrollment is unchanged.</small>{(workspace.terms.find((term) => term.id === termId)?.endsOn ?? "") < new Date().toISOString().slice(0, 10) && <small>This term has ended. Verify section availability with the registrar.</small>}</div>}
          <div className="semester-section-editor-list">{draft.sections.map((section, index) => {
            const linkedProfessor = professors.find((professor) => professor.id === section.professorRecordId && professor.courseId === section.courseId);
            const listedSection = catalogSections.find((item) => item.courseId === section.courseId && item.section.lineNumber === section.catalogSectionLineNumber);
            return <fieldset key={section.id} className="semester-section-editor"><legend>Section {index + 1}</legend><div className="semester-section-fields">
            <label className="field">Course<select value={section.courseId} onChange={(event) => updateSection(section.id, { courseId:event.target.value, instructorId:undefined, professorRecordId:undefined, catalogSectionLineNumber:undefined, sourceMeetingId:undefined })}>{!section.courseId && <option value="">Match {section.importedCourseLabel || "imported class"} to a course</option>}{courses.map((course) => <option value={course.id} key={course.id}>{course.code || course.title}</option>)}</select></label>
            <label className="field">Instructor<select value={section.professorRecordId ?? (section.instructorId ? `local:${section.instructorId}` : "")} onChange={(event) => updateSection(section.id, { instructorId:event.target.value.startsWith("local:") ? event.target.value.slice(6) : undefined, professorRecordId:event.target.value.startsWith("catalog:") ? event.target.value : undefined })}><option value="">Unknown / not listed</option><optgroup label="Your saved instructors">{workspace.instructors.filter((instructor) => instructor.courseId === section.courseId).map((instructor) => <option value={`local:${instructor.id}`} key={instructor.id}>{instructor.name}</option>)}</optgroup><optgroup label="Course-catalog listings">{professors.filter((professor) => professor.courseId === section.courseId && professor.source.kind === "official_course_catalog").map((professor) => <option value={professor.id} key={professor.id}>{professor.name} · {professor.source.termLabel || "term unknown"}{professor.source.campusId ? ` · ${professor.source.campusId}` : ""}</option>)}</optgroup></select></label>
            <label className="field">Start<input type="time" value={section.startsAtLocal} onChange={(event) => updateSection(section.id, { startsAtLocal:event.target.value })}/></label>
            <label className="field">End<input type="time" value={section.endsAtLocal} onChange={(event) => updateSection(section.id, { endsAtLocal:event.target.value })}/></label>
            <label className="field">Format<select value={section.modality} onChange={(event) => updateSection(section.id, { modality:event.target.value as SemesterScenarioSection["modality"] })}><option value="unknown">Unknown</option><option value="in_person">In person</option><option value="online">Online</option><option value="hybrid">Hybrid</option></select></label>
            <label className="field">Location<input value={section.location} maxLength={160} onChange={(event) => updateSection(section.id, { location:event.target.value })}/></label>
            <label className="field">Repeats every<select value={section.rotationIntervalWeeks ?? 1} onChange={(event) => updateSection(section.id, { rotationIntervalWeeks:Number(event.target.value), rotationOffsetWeeks:0 })}>{Array.from({ length:8 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} week{index ? "s" : ""}</option>)}</select></label>
            {(section.rotationIntervalWeeks ?? 1) > 1 && <label className="field">Occurs in week<select value={section.rotationOffsetWeeks ?? 0} onChange={(event) => updateSection(section.id, { rotationOffsetWeeks:Number(event.target.value) })}>{Array.from({ length:section.rotationIntervalWeeks ?? 1 }, (_, index) => <option key={index} value={index}>{index + 1}</option>)}</select></label>}
          </div>{(section.rotationIntervalWeeks ?? 1) > 1 && <small>Week 1 begins on {selectedTerm?.startsOn ?? "the term start date"}; the pattern repeats from there.</small>}<div className="semester-weekdays" role="group" aria-label={`Section ${index + 1} meeting days`}>{days.map((day, weekday) => <label key={day}><input type="checkbox" checked={section.weekdays.includes(weekday)} onChange={(event) => updateSection(section.id, { weekdays:event.target.checked ? [...section.weekdays, weekday].sort() : section.weekdays.filter((value) => value !== weekday) })}/>{day}</label>)}</div>
            {section.catalogSectionLineNumber && <div className="semester-professor-evidence" role="status">{listedSection ? <><strong>Catalog section #{listedSection.section.lineNumber}</strong><span>{listedSection.sourceLabel} · {listedSection.termLabel}{listedSection.section.campusId ? ` · ${listedSection.section.campusId} campus` : ""}</span><small>Review meeting details against the registrar before enrolling. Editing this draft does not change the source listing.</small>{listedSection.sourceUrl.startsWith("https://") && <a href={listedSection.sourceUrl} target="_blank" rel="noreferrer">View course source <ExternalLink /></a>}</> : <span>This catalog section is no longer available for this course and term. Choose another section before saving.</span>}</div>}
            {section.professorRecordId && <div className="semester-professor-evidence" role="status">{linkedProfessor ? <><strong>{linkedProfessor.name} · catalog listing</strong><span>{linkedProfessor.source.label} · {linkedProfessor.source.termLabel || "term unknown"}{linkedProfessor.source.campusId ? ` · ${linkedProfessor.source.campusId} campus` : ""}</span><small>Listed section{linkedProfessor.source.sectionNumbers.length === 1 ? "" : "s"}: {linkedProfessor.source.sectionNumbers.join(", ") || "not recorded"}. Verify current availability before enrolling.</small>{linkedProfessor.source.url.startsWith("https://") && <a href={linkedProfessor.source.url} target="_blank" rel="noreferrer">View course source <ExternalLink /></a>}{workspace.institution?.id === "104151" && ratingNote(linkedProfessor.id)}</> : <span>This catalog listing is no longer available for this course. Choose another instructor before saving.</span>}</div>}
            <button className="text-button" onClick={() => setDraft({ ...draft, sections:draft.sections.filter((item) => item.id !== section.id) })}>Remove section</button></fieldset>;
          })}</div>
          <button className="outline" disabled={!courses.length || busy} onClick={() => setDraft({ ...draft, sections:[...draft.sections, { id:crypto.randomUUID(), courseId:courses[0].id, weekdays:[1,3], startsAtLocal:"09:00", endsAtLocal:"10:15", location:"", modality:"unknown" }] })}><Plus /> Add candidate section</button>
          {!draft.sections.length && <p>Add at least one candidate section before saving.</p>}
          {draft.sections.length > 0 && !sectionsValid && <p className="form-error">Each section needs a valid course, meeting days, and times. Reassign any unavailable catalog section or instructor before saving.</p>}
          {candidate && baseline && <div className="semester-comparison"><h3>Compared with current schedule</h3><table><thead><tr><th scope="col">Measure</th><th scope="col">Current</th><th scope="col">This idea</th></tr></thead><tbody>
            <tr><th scope="row">Class hours</th><td>{hours(baseline.classMinutes)}</td><td>{hours(candidate.classMinutes)}</td></tr>
            <tr><th scope="row">In-person days</th><td>{baseline.campusDays.toFixed(1)}</td><td>{candidate.campusDays.toFixed(1)}</td></tr>
            <tr><th scope="row">Estimated round-trip commute</th><td>{hours(baseline.commuteMinutes)}</td><td>{hours(candidate.commuteMinutes)}</td></tr>
            <tr><th scope="row">Gaps between classes</th><td>{hours(baseline.gapMinutes)}</td><td>{hours(candidate.gapMinutes)}</td></tr>
            <tr><th scope="row">Class-time conflicts</th><td>{hours(baseline.classConflictMinutes)}</td><td>{hours(candidate.classConflictMinutes)}</td></tr>
            <tr><th scope="row">Protected-rhythm conflicts</th><td>{hours(baseline.rhythmConflictMinutes)}</td><td>{hours(candidate.rhythmConflictMinutes)}</td></tr>
            <tr><th scope="row">Known open assignment effort</th><td>{hours(baseline.knownWorkMinutes)}</td><td>{hours(candidate.knownWorkMinutes)}</td></tr>
          </tbody></table><p>Class, campus, commute, gap, and conflict figures are weekly averages over this term, including rotating weeks. Commute uses your default one-way time for each in-person day; it does not estimate travel between campuses. Hybrid/unknown meetings are not counted as campus days. Assignment effort totals unfinished tasks due this term for courses in each schedule; it is not a forecast of work not yet imported.</p></div>}
        </div>}
        {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="source-note" role="status">{notice}</p>}
      </section>
    </>}
    <div className="source-note"><ShieldCheck /> Schedule analysis is advisory. Verify enrollment and degree requirements with your registrar or advisor.</div>
  </div>;
}
