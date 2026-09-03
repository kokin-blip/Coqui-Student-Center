import { useCallback, useEffect, useState } from "react";
import {
  getLocalWorkspace,
  getStudyWorkspace,
  listAiProviders,
  type AiProviderStatus,
  type CourseRecord,
  type StudyArtifact,
  type StudyWorkspace,
} from "../../native";

export type StudyTab = "learn" | "materials" | "grades";

export function useStudyWorkspaceModel({
  initialCourseId,
  initialTab,
}: {
  initialCourseId?: string;
  initialTab?: StudyTab;
}) {
  const [study, setStudy] = useState<StudyWorkspace | null>(null);
  const [courses, setCourses] = useState<CourseRecord[]>([]);
  const [providers, setProviders] = useState<AiProviderStatus[]>([]);
  const [tab, setTab] = useState<StudyTab>(initialTab ?? "learn");
  const [selectedCourses, setSelectedCourses] = useState<string[]>(
    initialCourseId ? [initialCourseId] : [],
  );
  const [selectedMaterials, setSelectedMaterials] = useState<string[]>([]);
  const [capability, setCapability] = useState<
    | "source_qa"
    | "study_guide"
    | "flashcards"
    | "practice_questions"
    | "practice_test"
  >("source_qa");
  const [prompt, setPrompt] = useState("");
  const [artifactTitle, setArtifactTitle] = useState("");
  const [consent, setConsent] = useState(false);
  const [selectedArtifact, setSelectedArtifact] =
    useState<StudyArtifact | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [gradeCourse, setGradeCourse] = useState(initialCourseId ?? "");
  const [categoryName, setCategoryName] = useState("");
  const [categoryWeight, setCategoryWeight] = useState(20);
  const [gradeTitle, setGradeTitle] = useState("");
  const [gradeCategory, setGradeCategory] = useState("");
  const [gradeScore, setGradeScore] = useState("");
  const [gradePossible, setGradePossible] = useState(100);
  const [gradeStatus, setGradeStatus] = useState<
    "graded" | "missing" | "planned"
  >("graded");
  const [whatIf, setWhatIf] = useState<{
    percent?: number;
    projectedLetter?: string;
  } | null>(null);
  const [creditHours, setCreditHours] = useState(3);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [next, workspace, nextProviders] = await Promise.all([
        getStudyWorkspace(),
        getLocalWorkspace(),
        listAiProviders(),
      ]);
      setStudy(next);
      setCourses(workspace.courses);
      setProviders(nextProviders);
      setGradeCourse(
        (current) =>
          current || initialCourseId || workspace.courses[0]?.id || "",
      );
    } catch (next) {
      setError(String(next));
    } finally {
      setLoading(false);
    }
  }, [initialCourseId]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (
    operation: () => Promise<StudyWorkspace>,
    message: string,
  ) => {
    setBusy(true);
    setError("");
    try {
      setStudy(await operation());
      setNotice(message);
    } catch (next) {
      setError(String(next));
    } finally {
      setBusy(false);
    }
  };
  const provider = providers.find((item) => item.connected && item.healthy);
  const eligibleMaterials =
    study?.materials.filter((material) =>
      material.courseIds.some((id) => selectedCourses.includes(id)),
    ) ?? [];
  const courseName = (id: string) =>
    courses.find((course) => course.id === id)?.code ||
    courses.find((course) => course.id === id)?.title ||
    "Course";
  const currentGrade = study?.courseGrades.find(
    (grade) => grade.courseId === gradeCourse,
  );
  const currentScale = study?.gradingScales.find(
    (scale) => scale.courseId === gradeCourse,
  );
  const categories =
    study?.gradeCategories.filter(
      (category) => category.courseId === gradeCourse,
    ) ?? [];
  useEffect(() => {
    setCreditHours(currentScale?.creditHours ?? 3);
  }, [gradeCourse, currentScale?.creditHours]);

  return {
    study,
    setStudy,
    courses,
    providers,
    setProviders,
    tab,
    setTab,
    selectedCourses,
    setSelectedCourses,
    selectedMaterials,
    setSelectedMaterials,
    capability,
    setCapability,
    prompt,
    setPrompt,
    artifactTitle,
    setArtifactTitle,
    consent,
    setConsent,
    selectedArtifact,
    setSelectedArtifact,
    editTitle,
    setEditTitle,
    editContent,
    setEditContent,
    gradeCourse,
    setGradeCourse,
    categoryName,
    setCategoryName,
    categoryWeight,
    setCategoryWeight,
    gradeTitle,
    setGradeTitle,
    gradeCategory,
    setGradeCategory,
    gradeScore,
    setGradeScore,
    gradePossible,
    setGradePossible,
    gradeStatus,
    setGradeStatus,
    whatIf,
    setWhatIf,
    creditHours,
    setCreditHours,
    loading,
    busy,
    setBusy,
    error,
    setError,
    notice,
    setNotice,
    load,
    act,
    provider,
    eligibleMaterials,
    courseName,
    currentGrade,
    currentScale,
    categories,
  };
}

export type StudyViewModel = ReturnType<typeof useStudyWorkspaceModel>;
