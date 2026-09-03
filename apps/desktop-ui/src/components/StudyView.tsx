import { FileLock2 } from "lucide-react";
import { StudyGrades } from "../features/study/StudyGrades";
import { StudyLearn } from "../features/study/StudyLearn";
import { StudyMaterials } from "../features/study/StudyMaterials";
import {
  type StudyTab,
  useStudyWorkspaceModel,
} from "../features/study/studyModel";
import "../features/study/study.css";

export function StudyView({
  onOpenAssistant,
  initialCourseId,
  initialTab,
}: {
  onOpenAssistant: () => void;
  initialCourseId?: string;
  initialTab?: StudyTab;
}) {
  const vm = useStudyWorkspaceModel({ initialCourseId, initialTab });
  const { error, load, loading, notice, setTab, tab } = vm;
  return (
    <div className="content workspace-page mode-study">
      <div className="page-head">
        <div>
          <p className="eyebrow">Source-grounded learning</p>
          <h1>Study</h1>
          <p>
            Ask selected materials, edit cited study tools, schedule revision,
            and forecast grades locally.
          </p>
        </div>
        <span className="mode-pill">
          <FileLock2 /> Encrypted locally
        </span>
      </div>
      <nav className="segmented study-tabs" aria-label="Study sections">
        {(["learn", "materials", "grades"] as const).map((value) => (
          <button
            key={value}
            className={tab === value ? "active" : ""}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {value === "learn"
              ? "Learn"
              : value === "materials"
                ? "Materials"
                : "Grades"}
          </button>
        ))}
      </nav>
      {error && (
        <div className="error-summary study-error" role="alert">
          <span>{error}</span>
          {!vm.study && (
            <button className="text-button" onClick={() => void load()}>
              Try again
            </button>
          )}
        </div>
      )}
      {notice && (
        <p className="success-summary" role="status">
          {notice}
        </p>
      )}
      {loading ? (
        <section className="workspace-panel study-loading" aria-busy="true">
          <div className="skeleton-line wide" />
          <div className="skeleton-line" />
          <div className="skeleton-block" />
        </section>
      ) : tab === "materials" ? (
        <StudyMaterials vm={vm} />
      ) : tab === "grades" ? (
        <StudyGrades vm={vm} />
      ) : (
        <StudyLearn vm={vm} onOpenAssistant={onOpenAssistant} />
      )}
    </div>
  );
}
