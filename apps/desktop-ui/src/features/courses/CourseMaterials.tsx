import { Brain, HardDrive } from "lucide-react";
import { StudyWorkspace } from "../../native";
export function CourseMaterials({
  study,
  courseId,
  onStudy,
}: {
  study: StudyWorkspace | null;
  courseId: string;
  onStudy: () => void;
}) {
  const materials =
    study?.materials.filter((item) => item.courseIds.includes(courseId)) ?? [];
  return (
    <div className="course-section">
      <div className="section-head subhead">
        <div>
          <h3>Course materials</h3>
          <p>Encrypted sources assigned to this course.</p>
        </div>
        <button className="outline" onClick={onStudy}>
          Manage in Study
        </button>
      </div>
      {materials.length ? (
        <div className="record-list compact">
          {materials.map((item) => (
            <article key={item.id}>
              <HardDrive />
              <span>
                <strong>{item.fileName}</strong>
                <small>
                  {item.segmentCount} cited section
                  {item.segmentCount === 1 ? "" : "s"} · {item.mime}
                </small>
              </span>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <Brain />
          <strong>No course materials yet</strong>
          <p>Assign encrypted documents to this course in Study.</p>
          <button className="solid" onClick={onStudy}>
            Add course materials
          </button>
        </div>
      )}
    </div>
  );
}
