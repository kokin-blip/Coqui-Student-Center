import { useCallback, useEffect, useState } from "react";
import {
  ChevronRight,
  FileLock2,
  FileUp,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  AiProviderStatus,
  calculateGradeWhatIf,
  CourseRecord,
  generateGroundedStudyArtifact,
  getLocalWorkspace,
  getStudyWorkspace,
  listAiProviders,
  reviewStudyArtifact,
  saveGradeCategory,
  saveGradeItem,
  saveGradingScale,
  setStudyMaterialCourses,
  StudyArtifact,
  StudyWorkspace,
  updateStudyArtifact,
} from "../native";

type GradeBand = { label: string; minimumPercent: number; gradePoints: number };
const standardBands: GradeBand[] = [
  { label: "A", minimumPercent: 90, gradePoints: 4 },
  { label: "B", minimumPercent: 80, gradePoints: 3 },
  { label: "C", minimumPercent: 70, gradePoints: 2 },
  { label: "D", minimumPercent: 60, gradePoints: 1 },
  { label: "F", minimumPercent: 0, gradePoints: 0 },
];

function GradingScaleEditor({
  busy,
  courseId,
  initialBands,
  creditHours,
  onCreditHours,
  onSave,
}: {
  busy: boolean;
  courseId: string;
  initialBands?: GradeBand[];
  creditHours: number;
  onCreditHours: (value: number) => void;
  onSave: (bands: GradeBand[]) => void;
}) {
  const [bands, setBands] = useState<GradeBand[]>(initialBands?.length ? initialBands : standardBands);
  useEffect(() => {
    setBands(initialBands?.length ? initialBands : standardBands);
  }, [courseId, initialBands]);
  const setBand = (index: number, patch: Partial<GradeBand>) =>
    setBands((current) => current.map((band, position) => position === index ? { ...band, ...patch } : band));
  return (
    <section className="small-card grading-scale-editor">
      <h3>Your grading scale</h3>
      <p>Enter the cutoffs published for this course. Coqui does not assume that every school uses the same scale.</p>
      <label className="field">Credit hours<input type="number" min="0" step="0.5" value={creditHours} onChange={(event) => onCreditHours(Number(event.target.value))} /></label>
      <div className="grade-band-list">
        {bands.map((band, index) => (
          <div className="grade-band-row" key={`${index}-${band.label}`}>
            <label className="field">Letter<input value={band.label} onChange={(event) => setBand(index, { label: event.target.value })} /></label>
            <label className="field">Minimum %<input type="number" min="0" max="100" value={band.minimumPercent} onChange={(event) => setBand(index, { minimumPercent: Number(event.target.value) })} /></label>
            <label className="field">GPA points<input type="number" min="0" max="5" step="0.1" value={band.gradePoints} onChange={(event) => setBand(index, { gradePoints: Number(event.target.value) })} /></label>
            <button className="text-button danger" aria-label={`Remove ${band.label || "grade band"}`} disabled={bands.length === 1} onClick={() => setBands((current) => current.filter((_, position) => position !== index))}>Remove</button>
          </div>
        ))}
      </div>
      <div className="record-actions">
        <button className="outline" onClick={() => setBands((current) => [...current, { label: "", minimumPercent: 0, gradePoints: 0 }])}>Add band</button>
        <button className="outline" onClick={() => setBands(standardBands)}>Reset A–F</button>
        <button className="solid" disabled={busy || !courseId || bands.some((band) => !band.label.trim())} onClick={() => onSave(bands)}>Save this scale</button>
      </div>
    </section>
  );
}

export function StudyView({ onOpenAssistant }: { onOpenAssistant: () => void }) {
  const [study, setStudy] = useState<StudyWorkspace | null>(null);
  const [courses, setCourses] = useState<CourseRecord[]>([]);
  const [providers, setProviders] = useState<AiProviderStatus[]>([]);
  const [tab, setTab] = useState<"learn" | "materials" | "grades">("learn");
  const [selectedCourses, setSelectedCourses] = useState<string[]>([]);
  const [selectedMaterials, setSelectedMaterials] = useState<string[]>([]);
  const [capability, setCapability] = useState<"source_qa" | "study_guide" | "flashcards" | "practice_questions" | "practice_test">("source_qa");
  const [prompt, setPrompt] = useState("");
  const [artifactTitle, setArtifactTitle] = useState("");
  const [consent, setConsent] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<StudyArtifact | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [gradeCourse, setGradeCourse] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [categoryWeight, setCategoryWeight] = useState(20);
  const [gradeTitle, setGradeTitle] = useState("");
  const [gradeCategory, setGradeCategory] = useState("");
  const [gradeScore, setGradeScore] = useState("");
  const [gradePossible, setGradePossible] = useState(100);
  const [gradeStatus, setGradeStatus] = useState<"graded" | "missing" | "planned">("graded");
  const [whatIf, setWhatIf] = useState<{ percent?: number; projectedLetter?: string } | null>(null);
  const [creditHours, setCreditHours] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try {
      const [next, workspace, nextProviders] = await Promise.all([getStudyWorkspace(), getLocalWorkspace(), listAiProviders()]);
      setStudy(next); setCourses(workspace.courses); setProviders(nextProviders);
      setGradeCourse((current) => current || workspace.courses[0]?.id || "");
    } catch (next) { setError(String(next)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const act = async (operation: () => Promise<StudyWorkspace>, message: string) => {
    setBusy(true); setError("");
    try { setStudy(await operation()); setNotice(message); }
    catch (next) { setError(String(next)); }
    finally { setBusy(false); }
  };
  const provider = providers.find((item) => item.connected && item.healthy);
  const eligibleMaterials = study?.materials.filter((material) => material.courseIds.some((id) => selectedCourses.includes(id))) ?? [];
  const courseName = (id: string) => courses.find((course) => course.id === id)?.code || courses.find((course) => course.id === id)?.title || "Course";
  const currentGrade = study?.courseGrades.find((grade) => grade.courseId === gradeCourse);
  const currentScale = study?.gradingScales.find((scale) => scale.courseId === gradeCourse);
  const categories = study?.gradeCategories.filter((category) => category.courseId === gradeCourse) ?? [];
  useEffect(() => {
    setCreditHours(currentScale?.creditHours ?? 3);
  }, [gradeCourse, currentScale?.creditHours]);
  return (
    <div className="content workspace-page mode-study">
      <div className="page-head"><div><p className="eyebrow">Source-grounded learning</p><h1>Study</h1><p>Ask selected materials, edit cited study tools, schedule revision, and forecast grades locally.</p></div><span className="mode-pill"><FileLock2 /> Encrypted locally</span></div>
      <nav className="segmented study-tabs" aria-label="Study sections">
        {(["learn","materials","grades"] as const).map((value) => <button key={value} className={tab===value?"active":""} onClick={()=>setTab(value)}>{value === "learn" ? "Learn" : value === "materials" ? "Materials" : "Grades"}</button>)}
      </nav>
      {error && <p className="error-summary" role="alert">{error}</p>}{notice && <p className="success-summary" role="status">{notice}</p>}
      {tab === "materials" && <section className="workspace-panel"><div className="section-head"><div><h2>Course materials</h2><p>Assign each encrypted document to the exact courses allowed to use it.</p></div></div>
        {study?.materials.length ? <div className="material-list">{study.materials.map((material)=><article className="material-row" key={material.id}><div><strong>{material.fileName}</strong><small>{material.segmentCount} cited section{material.segmentCount===1?"":"s"} · {material.mime}</small></div><div className="course-chip-list">{courses.map((course)=><label key={course.id}><input type="checkbox" checked={material.courseIds.includes(course.id)} disabled={busy} onChange={(event)=>{const next=event.target.checked?[...material.courseIds,course.id]:material.courseIds.filter((id)=>id!==course.id);void act(()=>setStudyMaterialCourses(material.id,next),`${material.fileName} course access updated.`);}} />{course.code||course.title}</label>)}</div></article>)}</div>:<div className="empty-state"><FileUp/><strong>No imported materials yet.</strong><p>Use Bring in my schedule or the document vault to import a PDF, Word file, slides, image, or text.</p></div>}
      </section>}
      {tab === "learn" && <div className="study-grid"><section className="workspace-panel"><div className="section-head"><div><h2>Ask selected materials</h2><p>Citations are required and checked against the stored source text.</p></div><span>{provider ? `${provider.provider} · ${provider.model}` : "Provider needed"}</span></div>
        <div className="grounded-builder"><label className="field">Courses<select multiple value={selectedCourses} onChange={(event)=>{const values=[...event.currentTarget.selectedOptions].map((option)=>option.value);setSelectedCourses(values);setSelectedMaterials((current)=>current.filter((id)=>study?.materials.find((item)=>item.id===id)?.courseIds.some((course)=>values.includes(course))));}}>{courses.map((course)=><option key={course.id} value={course.id}>{course.code||course.title}</option>)}</select></label>
          <fieldset><legend>Materials sent for this request</legend>{eligibleMaterials.length?eligibleMaterials.map((material)=><label key={material.id}><input type="checkbox" checked={selectedMaterials.includes(material.id)} onChange={(event)=>setSelectedMaterials((current)=>event.target.checked?[...current,material.id]:current.filter((id)=>id!==material.id))}/>{material.fileName}</label>):<p>Assign materials to the selected course in Materials first.</p>}</fieldset>
          <div className="form-grid"><label className="field">Tool<select value={capability} onChange={(event)=>setCapability(event.target.value as typeof capability)}><option value="source_qa">Grounded answer</option><option value="study_guide">Study guide</option><option value="flashcards">Flashcards</option><option value="practice_questions">Practice questions</option><option value="practice_test">Practice test</option></select></label><label className="field">Title<input value={artifactTitle} onChange={(event)=>setArtifactTitle(event.target.value)} placeholder="Optional editable title"/></label></div>
          <label className="field">Request<textarea value={prompt} onChange={(event)=>setPrompt(event.target.value)} placeholder="Explain operant conditioning using only these notes…"/></label>
          <div className="consent-box"><ShieldCheck/><div><strong>Exact data scope</strong><p>{selectedMaterials.length ? selectedMaterials.map((id)=>study?.materials.find((item)=>item.id===id)?.fileName).filter(Boolean).join(", ") : "No materials selected"} will be sent to {provider?.provider ?? "the provider you configure"}. No other course or document is included.</p><label><input type="checkbox" checked={consent} onChange={(event)=>setConsent(event.target.checked)}/> I approve this request and provider data use.</label></div></div>
          <div className="modal-actions"><button className="outline" onClick={onOpenAssistant}>Provider settings</button><button className="solid" disabled={busy||!provider||!consent||!prompt.trim()||!selectedCourses.length||!selectedMaterials.length} onClick={async()=>{setBusy(true);setError("");try{const result=await generateGroundedStudyArtifact({capability,courseIds:selectedCourses,documentIds:selectedMaterials,prompt:prompt.trim(),title:artifactTitle.trim(),consent});setStudy(result.workspace);setNotice(`${result.provider} created a cited ${capability.replaceAll("_"," ")} for review.`);setPrompt("");setConsent(false);const artifact=result.workspace.artifacts.find((item)=>item.id===result.artifactId);if(artifact){setSelectedArtifact(artifact);setEditTitle(artifact.title);setEditContent(artifact.content);}}catch(next){setProviders(await listAiProviders().catch(()=>providers));setConsent(false);setError(`${String(next)} Nothing was sent to another provider. Review the newly resolved provider and consent again to retry.`);}finally{setBusy(false);}}}><Sparkles/>{busy?"Creating…":"Create cited result"}</button></div>
        </div>
        <div className="artifact-list">{study?.artifacts.map((artifact)=><button key={artifact.id} className={selectedArtifact?.id===artifact.id?"active":""} onClick={()=>{setSelectedArtifact(artifact);setEditTitle(artifact.title);setEditContent(artifact.content);}}><span><strong>{artifact.title}</strong><small>{courseName(artifact.courseId)} · {artifact.kind.replaceAll("_"," ")} · {artifact.provider}</small></span><ChevronRight/></button>)}</div>
      </section><aside className="side-stack">{selectedArtifact?<section className="small-card artifact-editor"><label className="field">Artifact title<input value={editTitle} onChange={(event)=>setEditTitle(event.target.value)}/></label><label className="field">Editable result<textarea value={editContent} onChange={(event)=>setEditContent(event.target.value)}/></label><button className="outline" disabled={busy} onClick={()=>void act(()=>updateStudyArtifact(selectedArtifact.id,editTitle,editContent),"Study artifact saved locally.")}>Save edits</button><h3>Citations</h3>{selectedArtifact.citations.length?selectedArtifact.citations.map((citation,index)=><blockquote key={`${citation.sourceId}-${index}`}><q>{citation.quote}</q><cite>{citation.locator}</cite></blockquote>):<p>This result is labeled unsupported by the selected materials.</p>}<h3>How well did you recall it?</h3><div className="confidence-row">{[1,2,3,4,5].map((value)=><button key={value} aria-label={`Confidence ${value}`} onClick={()=>void act(()=>reviewStudyArtifact(selectedArtifact.id,value),`Next review scheduled from confidence ${value}.`)}>{value}</button>)}</div></section>:<section className="small-card"><h3>Spaced revision</h3><p>Select an artifact, then record confidence. Coqui schedules the next 25-minute review through the deterministic planner and never moves locked blocks.</p>{study?.reviews.slice(0,4).map((review)=><small key={review.id}>Next review {new Date(review.nextReviewAt).toLocaleDateString()} · interval {review.intervalDays} days</small>)}</section>}</aside></div>}
      {tab === "grades" && <div className="study-grid"><section className="workspace-panel"><div className="section-head"><div><h2>Grades and what-if planning</h2><p>Only scales and scores you enter are used.</p></div>{study?.gpaProjection!==undefined&&<strong>Projected GPA {study.gpaProjection.toFixed(2)}</strong>}</div><label className="field">Course<select value={gradeCourse} onChange={(event)=>{setGradeCourse(event.target.value);setGradeCategory("");}}>{courses.map((course)=><option key={course.id} value={course.id}>{course.code||course.title}</option>)}</select></label>
        <div className="grade-summary"><article><span>Current</span><strong>{currentGrade?.currentPercent!==undefined?`${currentGrade.currentPercent.toFixed(1)}%`:"—"}</strong></article><article><span>Projected letter</span><strong>{currentGrade?.projectedLetter??"Add scale"}</strong></article><article><span>Missing-work impact</span><strong>{currentGrade?`${currentGrade.missingWorkImpact.toFixed(1)} pts`:"—"}</strong></article></div>
        <h3>Gradebook</h3><div className="grade-list">{study?.gradeItems.filter((item)=>item.courseId===gradeCourse).map((item)=><article key={item.id}><span><strong>{item.title}</strong><small>{item.status} · {categories.find((category)=>category.id===item.categoryId)?.name??"Uncategorized"}</small></span><b>{item.score??0}/{item.pointsPossible}</b></article>)}</div>
        <div className="form-grid"><label className="field">Item<input value={gradeTitle} onChange={(event)=>setGradeTitle(event.target.value)} placeholder="Midterm"/></label><label className="field">Category<select value={gradeCategory} onChange={(event)=>setGradeCategory(event.target.value)}><option value="">Uncategorized</option>{categories.map((category)=><option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label className="field">Score / what-if<input type="number" value={gradeScore} onChange={(event)=>{setGradeScore(event.target.value);setWhatIf(null);}} placeholder="Leave blank if planned"/></label><label className="field">Points possible<input type="number" min="0.1" value={gradePossible} onChange={(event)=>{setGradePossible(Number(event.target.value));setWhatIf(null);}}/></label><label className="field">Status<select value={gradeStatus} onChange={(event)=>setGradeStatus(event.target.value as typeof gradeStatus)}><option value="graded">Graded</option><option value="missing">Missing</option><option value="planned">What-if / planned</option></select></label></div>{whatIf&&<p className="success-summary">What-if projection: {whatIf.percent?.toFixed(1)??"—"}% {whatIf.projectedLetter?`· ${whatIf.projectedLetter}`:""}. Nothing was saved.</p>}<div className="modal-actions"><button className="outline" disabled={busy||!gradeCourse||gradeScore===""} onClick={async()=>{setError("");try{setWhatIf(await calculateGradeWhatIf({courseId:gradeCourse,categoryId:gradeCategory||undefined,title:gradeTitle||"What-if",score:Number(gradeScore),pointsPossible:gradePossible,status:"planned"}));}catch(next){setError(String(next));}}}>Preview what-if</button><button className="solid" disabled={busy||!gradeCourse||!gradeTitle.trim()} onClick={()=>void act(()=>saveGradeItem({courseId:gradeCourse,categoryId:gradeCategory||undefined,title:gradeTitle.trim(),score:gradeScore===""?undefined:Number(gradeScore),pointsPossible:gradePossible,status:gradeStatus}),gradeStatus==="planned"?"Planned what-if item saved separately from graded work.":"Grade item saved.")}>Add grade item</button></div>
      </section><aside className="side-stack"><section className="small-card"><h3>Categories</h3>{categories.map((category)=><p key={category.id}>{category.name} · {category.weight}%</p>)}<label className="field">Name<input value={categoryName} onChange={(event)=>setCategoryName(event.target.value)} placeholder="Exams"/></label><label className="field">Weight %<input type="number" min="0" max="100" value={categoryWeight} onChange={(event)=>setCategoryWeight(Number(event.target.value))}/></label><button className="outline" disabled={busy||!categoryName.trim()||!gradeCourse} onClick={()=>void act(()=>saveGradeCategory({courseId:gradeCourse,name:categoryName.trim(),weight:categoryWeight}),"Grade category saved.")}>Add category</button></section><GradingScaleEditor busy={busy} courseId={gradeCourse} initialBands={currentScale?.bands} creditHours={creditHours} onCreditHours={setCreditHours} onSave={(bands)=>void act(()=>saveGradingScale(gradeCourse,bands,creditHours),"Course grading scale saved.")} /></aside></div>}
    </div>
  );
}
