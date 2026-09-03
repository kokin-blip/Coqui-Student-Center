import { ChevronRight, ShieldCheck, Sparkles } from "lucide-react";
import {
  generateGroundedStudyArtifact,
  listAiProviders,
  reviewStudyArtifact,
  updateStudyArtifact,
} from "../../native";
import type { StudyViewModel } from "./studyModel";

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
    consent,
    courseName,
    courses,
    editContent,
    editTitle,
    eligibleMaterials,
    prompt,
    provider,
    providers,
    selectedArtifact,
    selectedCourses,
    selectedMaterials,
    setArtifactTitle,
    setBusy,
    setCapability,
    setConsent,
    setEditContent,
    setEditTitle,
    setError,
    setNotice,
    setPrompt,
    setProviders,
    setSelectedArtifact,
    setSelectedCourses,
    setSelectedMaterials,
    setStudy,
    study,
  } = vm;

  return (
    <div className="study-grid study-learn-grid">
      <section className="workspace-panel study-builder-panel">
        <div className="section-head">
          <div>
            <h2>Ask selected materials</h2>
            <p>
              Citations are required and checked against the stored source text.
            </p>
          </div>
          <span>
            {provider
              ? `${provider.provider} · ${provider.model}`
              : "Provider needed"}
          </span>
        </div>
        <div className="grounded-builder">
          <label className="field">
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
          <fieldset>
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
          <div className="consent-box">
            <ShieldCheck />
            <div>
              <strong>Exact data scope</strong>
              <p>
                {selectedMaterials.length
                  ? selectedMaterials
                      .map(
                        (id) =>
                          study?.materials.find((item) => item.id === id)
                            ?.fileName,
                      )
                      .filter(Boolean)
                      .join(", ")
                  : "No materials selected"}{" "}
                will be sent to{" "}
                {provider?.provider ?? "the provider you configure"}. No other
                course or document is included.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />{" "}
                I approve this request and provider data use.
              </label>
            </div>
          </div>
          <div className="modal-actions">
            <button className="outline" onClick={onOpenAssistant}>
              Provider settings
            </button>
            <button
              className="solid"
              disabled={
                busy ||
                !provider ||
                !consent ||
                !prompt.trim() ||
                !selectedCourses.length ||
                !selectedMaterials.length
              }
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const result = await generateGroundedStudyArtifact({
                    capability,
                    courseIds: selectedCourses,
                    documentIds: selectedMaterials,
                    prompt: prompt.trim(),
                    title: artifactTitle.trim(),
                    consent,
                  });
                  setStudy(result.workspace);
                  setNotice(
                    `${result.provider} created a cited ${capability.replaceAll("_", " ")} for review.`,
                  );
                  setPrompt("");
                  setConsent(false);
                  const artifact = result.workspace.artifacts.find(
                    (item) => item.id === result.artifactId,
                  );
                  if (artifact) {
                    setSelectedArtifact(artifact);
                    setEditTitle(artifact.title);
                    setEditContent(artifact.content);
                  }
                } catch (next) {
                  setProviders(await listAiProviders().catch(() => providers));
                  setConsent(false);
                  setError(
                    `${String(next)} Nothing was sent to another provider. Review the newly resolved provider and consent again to retry.`,
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Sparkles />
              {busy ? "Creating…" : "Create cited result"}
            </button>
          </div>
        </div>
        <div className="artifact-list" aria-label="Saved study artifacts">
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
        </div>
      </section>
      <aside className="side-stack study-artifact-inspector">
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
                    updateStudyArtifact(
                      selectedArtifact.id,
                      editTitle,
                      editContent,
                    ),
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
                This result is labeled unsupported by the selected materials.
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
      </aside>
    </div>
  );
}
