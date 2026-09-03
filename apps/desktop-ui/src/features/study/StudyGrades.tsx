import { useEffect, useState } from "react";
import {
  calculateGradeWhatIf,
  saveGradeCategory,
  saveGradeItem,
  saveGradingScale,
} from "../../native";
import type { StudyViewModel } from "./studyModel";

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
  const [bands, setBands] = useState<GradeBand[]>(
    initialBands?.length ? initialBands : standardBands,
  );
  useEffect(
    () => setBands(initialBands?.length ? initialBands : standardBands),
    [courseId, initialBands],
  );
  const setBand = (index: number, patch: Partial<GradeBand>) =>
    setBands((current) =>
      current.map((band, position) =>
        position === index ? { ...band, ...patch } : band,
      ),
    );
  return (
    <section className="small-card grading-scale-editor">
      <h3>Your grading scale</h3>
      <p>
        Enter the cutoffs published for this course. Coqui does not assume that
        every school uses the same scale.
      </p>
      <label className="field">
        Credit hours
        <input
          type="number"
          min="0"
          step="0.5"
          value={creditHours}
          onChange={(event) => onCreditHours(Number(event.target.value))}
        />
      </label>
      <div className="grade-band-list">
        {bands.map((band, index) => (
          <div className="grade-band-row" key={`${index}-${band.label}`}>
            <label className="field">
              Letter
              <input
                value={band.label}
                onChange={(event) =>
                  setBand(index, { label: event.target.value })
                }
              />
            </label>
            <label className="field">
              Minimum %
              <input
                type="number"
                min="0"
                max="100"
                value={band.minimumPercent}
                onChange={(event) =>
                  setBand(index, { minimumPercent: Number(event.target.value) })
                }
              />
            </label>
            <label className="field">
              GPA points
              <input
                type="number"
                min="0"
                max="5"
                step="0.1"
                value={band.gradePoints}
                onChange={(event) =>
                  setBand(index, { gradePoints: Number(event.target.value) })
                }
              />
            </label>
            <button
              className="text-button danger"
              aria-label={`Remove ${band.label || "grade band"}`}
              disabled={bands.length === 1}
              onClick={() =>
                setBands((current) =>
                  current.filter((_, position) => position !== index),
                )
              }
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className="record-actions">
        <button
          className="outline"
          onClick={() =>
            setBands((current) => [
              ...current,
              { label: "", minimumPercent: 0, gradePoints: 0 },
            ])
          }
        >
          Add band
        </button>
        <button className="outline" onClick={() => setBands(standardBands)}>
          Reset A–F
        </button>
        <button
          className="solid"
          disabled={
            busy || !courseId || bands.some((band) => !band.label.trim())
          }
          onClick={() => onSave(bands)}
        >
          Save this scale
        </button>
      </div>
    </section>
  );
}

export function StudyGrades({ vm }: { vm: StudyViewModel }) {
  const {
    act,
    busy,
    categories,
    categoryName,
    categoryWeight,
    courses,
    creditHours,
    currentGrade,
    currentScale,
    gradeCategory,
    gradeCourse,
    gradePossible,
    gradeScore,
    gradeStatus,
    gradeTitle,
    setCategoryName,
    setCategoryWeight,
    setCreditHours,
    setError,
    setGradeCategory,
    setGradeCourse,
    setGradePossible,
    setGradeScore,
    setGradeStatus,
    setGradeTitle,
    setWhatIf,
    study,
    whatIf,
  } = vm;
  return (
    <div className="study-grid study-grades-grid">
      <section className="workspace-panel">
        <div className="section-head">
          <div>
            <h2>Grades and what-if planning</h2>
            <p>Only scales and scores you enter are used.</p>
          </div>
          {study?.gpaProjection !== undefined && (
            <strong>Projected GPA {study.gpaProjection.toFixed(2)}</strong>
          )}
        </div>
        <label className="field study-course-picker">
          Course
          <select
            value={gradeCourse}
            onChange={(event) => {
              setGradeCourse(event.target.value);
              setGradeCategory("");
            }}
          >
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.code || course.title}
              </option>
            ))}
          </select>
        </label>
        <div className="grade-summary">
          <article>
            <span>Current</span>
            <strong>
              {currentGrade?.currentPercent !== undefined
                ? `${currentGrade.currentPercent.toFixed(1)}%`
                : "—"}
            </strong>
          </article>
          <article>
            <span>Projected letter</span>
            <strong>{currentGrade?.projectedLetter ?? "Add scale"}</strong>
          </article>
          <article>
            <span>Missing-work impact</span>
            <strong>
              {currentGrade
                ? `${currentGrade.missingWorkImpact.toFixed(1)} pts`
                : "—"}
            </strong>
          </article>
        </div>
        <h3>Gradebook</h3>
        <div className="grade-list">
          {study?.gradeItems
            .filter((item) => item.courseId === gradeCourse)
            .map((item) => (
              <article key={item.id}>
                <span>
                  <strong>{item.title}</strong>
                  <small>
                    {item.status} ·{" "}
                    {categories.find(
                      (category) => category.id === item.categoryId,
                    )?.name ?? "Uncategorized"}
                  </small>
                </span>
                <b>
                  {item.score ?? 0}/{item.pointsPossible}
                </b>
              </article>
            ))}
        </div>
        <details className="progressive-form">
          <summary>Add a grade or what-if</summary>
          <div className="form-grid">
            <label className="field">
              Item
              <input
                value={gradeTitle}
                onChange={(event) => setGradeTitle(event.target.value)}
                placeholder="Midterm"
              />
            </label>
            <label className="field">
              Category
              <select
                value={gradeCategory}
                onChange={(event) => setGradeCategory(event.target.value)}
              >
                <option value="">Uncategorized</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Score / what-if
              <input
                type="number"
                value={gradeScore}
                onChange={(event) => {
                  setGradeScore(event.target.value);
                  setWhatIf(null);
                }}
                placeholder="Leave blank if planned"
              />
            </label>
            <label className="field">
              Points possible
              <input
                type="number"
                min="0.1"
                value={gradePossible}
                onChange={(event) => {
                  setGradePossible(Number(event.target.value));
                  setWhatIf(null);
                }}
              />
            </label>
            <label className="field">
              Status
              <select
                value={gradeStatus}
                onChange={(event) =>
                  setGradeStatus(event.target.value as typeof gradeStatus)
                }
              >
                <option value="graded">Graded</option>
                <option value="missing">Missing</option>
                <option value="planned">What-if / planned</option>
              </select>
            </label>
          </div>
          {whatIf && (
            <p className="success-summary">
              What-if projection: {whatIf.percent?.toFixed(1) ?? "—"}%{" "}
              {whatIf.projectedLetter ? `· ${whatIf.projectedLetter}` : ""}.
              Nothing was saved.
            </p>
          )}
          <div className="modal-actions">
            <button
              className="outline"
              disabled={busy || !gradeCourse || gradeScore === ""}
              onClick={async () => {
                setError("");
                try {
                  setWhatIf(
                    await calculateGradeWhatIf({
                      courseId: gradeCourse,
                      categoryId: gradeCategory || undefined,
                      title: gradeTitle || "What-if",
                      score: Number(gradeScore),
                      pointsPossible: gradePossible,
                      status: "planned",
                    }),
                  );
                } catch (next) {
                  setError(String(next));
                }
              }}
            >
              Preview what-if
            </button>
            <button
              className="solid"
              disabled={busy || !gradeCourse || !gradeTitle.trim()}
              onClick={() =>
                void act(
                  () =>
                    saveGradeItem({
                      courseId: gradeCourse,
                      categoryId: gradeCategory || undefined,
                      title: gradeTitle.trim(),
                      score: gradeScore === "" ? undefined : Number(gradeScore),
                      pointsPossible: gradePossible,
                      status: gradeStatus,
                    }),
                  gradeStatus === "planned"
                    ? "Planned what-if item saved separately from graded work."
                    : "Grade item saved.",
                )
              }
            >
              Add grade item
            </button>
          </div>
        </details>
      </section>
      <aside className="side-stack study-grade-inspector">
        <section className="small-card">
          <h3>Categories</h3>
          {categories.length ? (
            categories.map((category) => (
              <p key={category.id}>
                {category.name} · {category.weight}%
              </p>
            ))
          ) : (
            <p>No weighted categories yet.</p>
          )}
          <label className="field">
            Name
            <input
              value={categoryName}
              onChange={(event) => setCategoryName(event.target.value)}
              placeholder="Exams"
            />
          </label>
          <label className="field">
            Weight %
            <input
              type="number"
              min="0"
              max="100"
              value={categoryWeight}
              onChange={(event) =>
                setCategoryWeight(Number(event.target.value))
              }
            />
          </label>
          <button
            className="outline"
            disabled={busy || !categoryName.trim() || !gradeCourse}
            onClick={() =>
              void act(
                () =>
                  saveGradeCategory({
                    courseId: gradeCourse,
                    name: categoryName.trim(),
                    weight: categoryWeight,
                  }),
                "Grade category saved.",
              )
            }
          >
            Add category
          </button>
        </section>
        <GradingScaleEditor
          busy={busy}
          courseId={gradeCourse}
          initialBands={currentScale?.bands}
          creditHours={creditHours}
          onCreditHours={setCreditHours}
          onSave={(bands) =>
            void act(
              () => saveGradingScale(gradeCourse, bands, creditHours),
              "Course grading scale saved.",
            )
          }
        />
      </aside>
    </div>
  );
}
