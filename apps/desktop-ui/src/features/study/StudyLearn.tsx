import { CourseDifficultyEditor } from "./CourseDifficultyEditor";
import type { CourseDifficulty } from "../../native";
import { GroundedComposer } from "./GroundedComposer";
import { ChevronRight, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import {
  listAiProviders,
  reviewStudyArtifact,
  rerankStudyMaterials,
  saveStudyNote,
} from "../../native";
import type { StudyViewModel } from "./studyModel";
import { aiRerankCandidateIds, applyAiRerank, recommendationReasonLabels, recommendStudyMaterials, studyTargets } from "./recommendations";

export function StudyLearn({
  vm,
  onOpenAssistant,
}: {
  vm: StudyViewModel;
  onOpenAssistant: () => void;
}) {
  const {
    act,
    artifactTitle,
    busy,
    capability,
    courseName,
    courses,
    editContent,
    editTitle,
    eligibleMaterials,
    prompt,
    provider,
    selectedArtifact,
    selectedCourses,
    selectedMaterials,
    setArtifactTitle,
    setCapability,
    setEditContent,
    setEditTitle,
    setError,
    setNotice,
    setPrompt,
    setSelectedArtifact,
    setSelectedCourses,
    setSelectedMaterials,
    study,
    tasks,
  } = vm;
  const [difficulties,setDifficulties] = useState<CourseDifficulty[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [rerankConsent, setRerankConsent] = useState(false);
  const [reranking, setReranking] = useState(false);
  const [rerankError, setRerankError] = useState("");
  const [aiOrder, setAiOrder] = useState<{ key: string; ids: string[]; provider: string } | null>(null);
  const recommendationCourseId = selectedCourses[0] ?? "";
  const targets = studyTargets(tasks, recommendationCourseId);
  const target = targets.find((item) => item.id === selectedTargetId) ?? targets[0];
  const recommendations = recommendStudyMaterials(study?.materials ?? [], recommendationCourseId, target, new Date(), difficulties.filter(d=>d.courseId===recommendationCourseId&&!d.easier).map(d=>d.concept)).slice(0, 5);
  const candidateIds = aiRerankCandidateIds(recommendations);
  const rerankKey = JSON.stringify([recommendationCourseId, target?.id, recommendations.map((item) => [item.materialId, item.score])]);
  const rerankScope = JSON.stringify({targetTitle:target?.title??"",materials:candidateIds.map(id=>{const m=study?.materials.find(m=>m.id===id);return {id,title:m?.title||m?.fileName||"",materialType:m?.materialType||"other",topics:m?.topics??[]};})});
  useEffect(()=>setRerankConsent(false),[rerankScope,provider?.provider,provider?.model]);
  const visibleRecommendations = aiOrder?.key === rerankKey ? applyAiRerank(recommendations, aiOrder.ids) : recommendations;

  return (
    <div className="study-grid study-learn-grid">
      <section className="workspace-panel study-builder-panel">
        <label className="field study-course-picker">Course<select value={selectedCourses[0]??""} onChange={e=>{setSelectedCourses(e.target.value?[e.target.value]:[]);setSelectedMaterials([]);setSelectedTargetId("");setDifficulties([]);}}><option value="">Choose a course</option>{courses.map(course=><option key={course.id} value={course.id}>{course.code||course.title}</option>)}</select></label>
        {!courses.length&&<p>Add a course in Courses to start studying.</p>}
        <CourseDifficultyEditor key={recommendationCourseId} courseId={recommendationCourseId} onChange={setDifficulties} onPractice={record=>{setCapability("practice_questions");setPrompt(`Help me practice ${record.concept}. My note: ${record.note || "No additional note"}. Use only the selected materials.`);setNotice("Practice request prepared. Select materials, review the exact AI scope, and consent before sending.");}} />
        <div className="study-recommendations">
          <div className="section-head"><div><h2>What to study next</h2><p>Choose a target, then the materials that support it.</p></div></div>
          {recommendationCourseId && targets.length > 0 && <label className="field recommendation-target">Study target
            <select value={target?.id ?? ""} onChange={(event) => setSelectedTargetId(event.target.value)}>
              {targets.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.dueAt ? new Date(item.dueAt).toLocaleDateString() : "No due date"}</option>)}
            </select>
          </label>}
          {recommendations.length ? <div className="course-chip-list">{visibleRecommendations.map((recommendation) => {
            const material = study?.materials.find((item) => item.id === recommendation.materialId);
            if (!material) return null;
            return <button type="button" aria-pressed={selectedMaterials.includes(material.id)} className={selectedMaterials.includes(material.id) ? "mode-pill active" : "mode-pill"} key={material.id} onClick={() => setSelectedMaterials((current) => current.includes(material.id) ? current.filter((id) => id !== material.id) : [...current, material.id])}><strong>{material.title ?? material.fileName}</strong><small>{(material.materialType ?? "other").replaceAll("_", " ")} · {recommendation.reasonCodes.map((code) => recommendationReasonLabels[code]).join(" · ")}</small></button>;
          })}</div> : <div className="field-help">{recommendationCourseId ? <><p>No materials for this course yet.</p><button className="outline" onClick={()=>vm.setTab("materials")}>Add materials</button></> : <p>Choose a course to see its materials.</p>}</div>}
          {target && candidateIds.length >= 2 && <details className="recommendation-refine"><summary>Refine uncertain matches with AI</summary>
            <p>Optional AI tie-break: only this target title and the titles, types, and topics of {candidateIds.length} uncertain materials are sent to {provider ? `${provider.provider} · ${provider.model}` : "your connected provider"}. Document text and other courses stay on this device. Strong matches keep their place.</p>
            <details><summary>Exact metadata sent</summary><pre className="source-text">{rerankScope}</pre></details>
            <label><input type="checkbox" checked={rerankConsent} onChange={(event) => setRerankConsent(event.target.checked)} /> I approve sending this metadata for AI refinement.</label>
            <button type="button" className="outline" disabled={!provider || !rerankConsent || reranking} onClick={async () => {
              setReranking(true);
              setRerankError("");
              try {
                const result = await rerankStudyMaterials({ courseId: recommendationCourseId, targetId: target.id, materialIds: candidateIds, consent: true, expectedProvider:provider!.provider,expectedModel:provider!.model,sourceScope:rerankScope });
                setAiOrder({ key: rerankKey, ids: result.rankedIds, provider: result.provider });
              } catch (error) {
                setRerankError(`${String(error)} Deterministic recommendations remain available.`);
              } finally {
                setReranking(false);
                setRerankConsent(false);
              }
            }}>{reranking ? "Refining…" : "Refine uncertain matches with AI"}</button>
            {!provider && <button type="button" className="outline" onClick={onOpenAssistant}>Connect AI provider</button>}
            {aiOrder?.key === rerankKey && <small>Uncertain matches refined by {aiOrder.provider}; course scope and strong matches unchanged.</small>}
            {rerankError && <p role="alert">{rerankError}</p>}
          </details>}
        </div>
        {eligibleMaterials.length > 0 && <>
        <div className="section-head">
          <div>
            <h2>Ask selected materials</h2>
            <p>
              Choose practice or a question. Citations are checked against the stored source text.
            </p>
          </div>
          <span>
            {provider
              ? `${provider.provider} · ${provider.model}`
              : "Provider needed"}
          </span>
        </div>
        <div className="grounded-builder">
          <details className="progressive-form"><summary>Include more courses in this question</summary><label className="field">
            Courses
            <select
              multiple
              value={selectedCourses}
              onChange={(event) => {
                const values = [...event.currentTarget.selectedOptions].map(
                  (option) => option.value,
                );
                setSelectedCourses(values);
                setSelectedMaterials((current) =>
                  current.filter((id) =>
                    study?.materials
                      .find((item) => item.id === id)
                      ?.courseIds.some((course) => values.includes(course)),
                  ),
                );
              }}
            >
              {courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.code || course.title}
                </option>
              ))}
            </select>
          </label>
          </details><fieldset>
            <legend>Materials sent for this request</legend>
            {eligibleMaterials.length ? (
              eligibleMaterials.map((material) => (
                <label key={material.id}>
                  <input
                    type="checkbox"
                    checked={selectedMaterials.includes(material.id)}
                    onChange={(event) =>
                      setSelectedMaterials((current) =>
                        event.target.checked
                          ? [...current, material.id]
                          : current.filter((id) => id !== material.id),
                      )
                    }
                  />
                  {material.fileName}
                </label>
              ))
            ) : (
              <p>Assign materials to the selected course in Materials first.</p>
            )}
          </fieldset>
          <div className="form-grid">
            <label className="field">
              Tool
              <select
                value={capability}
                onChange={(event) =>
                  setCapability(event.target.value as typeof capability)
                }
              >
                <option value="notes">Structured notes</option>
                <option value="summary">Summary</option>
                <option value="outline">Outline</option>
                <option value="slides">Slide draft</option>
                <option value="source_qa">Grounded answer</option>
                <option value="study_guide">Study guide</option>
                <option value="flashcards">Flashcards</option>
                <option value="practice_questions">Practice questions</option>
                <option value="practice_test">Practice test</option>
              </select>
            </label>
            <label className="field">
              Title
              <input
                value={artifactTitle}
                onChange={(event) => setArtifactTitle(event.target.value)}
                placeholder="Optional editable title"
              />
            </label>
          </div>
          <label className="field">
            Request
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Explain operant conditioning using only these notes…"
            />
          </label>
          <GroundedComposer vm={vm} />
          <button className="outline" onClick={onOpenAssistant}>Provider settings</button>
        </div>
        </>}
        <details className="progressive-form"><summary>Saved study tools</summary><div className="artifact-list" aria-label="Saved study artifacts">
          {study?.artifacts.length ? (
            study.artifacts.map((artifact) => (
              <button
                key={artifact.id}
                className={selectedArtifact?.id === artifact.id ? "active" : ""}
                aria-pressed={selectedArtifact?.id === artifact.id}
                onClick={() => {
                  setSelectedArtifact(artifact);
                  setEditTitle(artifact.title);
                  setEditContent(artifact.content);
                }}
              >
                <span>
                  <strong>{artifact.title}</strong>
                  <small>
                    {courseName(artifact.courseId)} ·{" "}
                    {artifact.kind.replaceAll("_", " ")} · {artifact.provider}
                  </small>
                </span>
                <ChevronRight />
              </button>
            ))
          ) : (
            <div className="empty-state compact-empty">
              <strong>No study artifacts yet.</strong>
              <p>Select a course and source material to create one.</p>
            </div>
          )}
        </div></details>
      </section>
      <details className="study-artifact-inspector"><summary>{selectedArtifact ? "Review and edit selected study tool" : "Spaced revision"}</summary>
        {selectedArtifact ? (
          <section className="small-card artifact-editor">
            <div className="inspector-kicker">Selected artifact</div>
            <label className="field">
              Artifact title
              <input
                value={editTitle}
                onChange={(event) => setEditTitle(event.target.value)}
              />
            </label>
            <label className="field">
              Editable result
              <textarea
                value={editContent}
                onChange={(event) => setEditContent(event.target.value)}
              />
            </label>
            <button
              className="outline"
              disabled={busy}
              onClick={() =>
                void act(
                  () =>
                    saveStudyNote({id:selectedArtifact.id,expectedRevision:selectedArtifact.revision??1,courseId:selectedArtifact.courseId,kind:selectedArtifact.kind,title:editTitle,content:editContent,tags:selectedArtifact.tags??[],pinned:selectedArtifact.pinned??false,sourceIds:selectedArtifact.sourceIds??[]}),
                  "Study artifact saved locally.",
                )
              }
            >
              Save edits
            </button>
            <h3>Citations</h3>
            {selectedArtifact.citations.length ? (
              selectedArtifact.citations.map((citation, index) => (
                <blockquote key={`${citation.sourceId}-${index}`}>
                  <q>{citation.quote}</q>
                  <cite>{citation.locator}</cite>
                </blockquote>
              ))
            ) : (
              <p>
                {selectedArtifact.provider === "manual" ? "Locally authored note. Source links are available in Materials." : "This result is labeled unsupported by the selected materials."}
              </p>
            )}
            <h3>How well did you recall it?</h3>
            <div className="confidence-row">
              {[1, 2, 3, 4, 5].map((value) => (
                <button
                  key={value}
                  aria-label={`Confidence ${value}`}
                  onClick={() =>
                    void act(
                      () => reviewStudyArtifact(selectedArtifact.id, value),
                      `Next review scheduled from confidence ${value}.`,
                    )
                  }
                >
                  {value}
                </button>
              ))}
            </div>
          </section>
        ) : (
          <section className="small-card">
            <div className="inspector-kicker">Revision queue</div>
            <h3>Spaced revision</h3>
            <p>
              Select an artifact, then record confidence. Coqui schedules the
              next 25-minute review through the deterministic planner and never
              moves locked blocks.
            </p>
            {study?.reviews.slice(0, 4).map((review) => (
              <small key={review.id}>
                Next review {new Date(review.nextReviewAt).toLocaleDateString()}{" "}
                · interval {review.intervalDays} days
              </small>
            ))}
          </section>
        )}
      </details>
    </div>
  );
}
