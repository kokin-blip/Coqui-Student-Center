import { FileUp } from "lucide-react";
import { setStudyMaterialCourses } from "../../native";
import type { StudyViewModel } from "./studyModel";

export function StudyMaterials({ vm }: { vm: StudyViewModel }) {
  const { act, busy, courses, study } = vm;

  return (
    <section className="workspace-panel study-materials-panel">
      <div className="section-head">
        <div>
          <h2>Course materials</h2>
          <p>
            Assign each encrypted document to the exact courses allowed to use
            it.
          </p>
        </div>
      </div>
      {study?.materials.length ? (
        <div className="material-list">
          {study.materials.map((material) => (
            <article className="material-row" key={material.id}>
              <div>
                <strong>{material.fileName}</strong>
                <small>
                  {material.segmentCount} cited section
                  {material.segmentCount === 1 ? "" : "s"} · {material.mime}
                </small>
              </div>
              <fieldset className="course-chip-list">
                <legend>Course access</legend>
                {courses.map((course) => (
                  <label key={course.id}>
                    <input
                      type="checkbox"
                      checked={material.courseIds.includes(course.id)}
                      disabled={busy}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...material.courseIds, course.id]
                          : material.courseIds.filter((id) => id !== course.id);
                        void act(
                          () => setStudyMaterialCourses(material.id, next),
                          `${material.fileName} course access updated.`,
                        );
                      }}
                    />
                    {course.code || course.title}
                  </label>
                ))}
              </fieldset>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <FileUp />
          <strong>No imported materials yet.</strong>
          <p>
            Use Bring in my schedule or the document vault to import a PDF, Word
            file, slides, image, or text.
          </p>
        </div>
      )}
    </section>
  );
}
