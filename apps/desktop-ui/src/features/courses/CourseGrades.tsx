import { Brain } from "lucide-react";
import { StudyWorkspace } from "../../native";
export function CourseGrades({
  study,
  courseId,
  onStudy,
}: {
  study: StudyWorkspace | null;
  courseId: string;
  onStudy: () => void;
}) {
  const grade = study?.courseGrades.find((item) => item.courseId === courseId);
  const items =
    study?.gradeItems.filter((item) => item.courseId === courseId) ?? [];
  return (
    <div className="course-section">
      <div className="section-head subhead">
        <div>
          <h3>Grades and forecast</h3>
          <p>A course-level view of locally entered scores.</p>
        </div>
        <button className="outline" onClick={onStudy}>
          Edit in Study
        </button>
      </div>
      {grade || items.length ? (
        <>
          <div className="grade-summary">
            <article>
              <span>Current</span>
              <strong>
                {grade?.currentPercent !== undefined
                  ? `${grade.currentPercent.toFixed(1)}%`
                  : "—"}
              </strong>
            </article>
            <article>
              <span>Projected letter</span>
              <strong>{grade?.projectedLetter ?? "Add scale"}</strong>
            </article>
            <article>
              <span>Missing-work impact</span>
              <strong>
                {grade ? `${grade.missingWorkImpact.toFixed(1)} pts` : "—"}
              </strong>
            </article>
          </div>
          <div className="grade-list">
            {items.map((item) => (
              <article key={item.id}>
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.status}</small>
                </span>
                <b>
                  {item.score ?? 0}/{item.pointsPossible}
                </b>
              </article>
            ))}
          </div>
        </>
      ) : (
        <div className="empty-state">
          <Brain />
          <strong>No grades yet</strong>
          <p>
            Add categories, scores, and a grading scale in Study to see
            forecasts here.
          </p>
          <button className="solid" onClick={onStudy}>
            Set up grades
          </button>
        </div>
      )}
    </div>
  );
}
