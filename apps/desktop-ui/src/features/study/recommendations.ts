import type { StudyMaterial, TaskRecord } from "../../native";

export type StudyRecommendation = {
  materialId: string;
  targetId: string | null;
  score: number;
  reasonCodes: string[];
};

const assessmentKinds = new Set(["exam", "midterm", "final", "test", "quiz"]);
const practiceTypes = new Set(["practice_exam", "previous_exam", "previous_quiz", "study_guide"]);

export function studyTargets(tasks: TaskRecord[], courseId: string, now = new Date()): TaskRecord[] {
  return tasks.filter((task) => task.courseId === courseId && !task.completed && task.dueAt && new Date(task.dueAt).getTime() >= now.getTime())
    .sort((a, b) => Number(assessmentKinds.has(b.kind)) - Number(assessmentKinds.has(a.kind)) || (a.dueAt ?? "").localeCompare(b.dueAt ?? "") || a.id.localeCompare(b.id));
}

export function recommendStudyMaterials(
  materials: StudyMaterial[],
  courseId: string,
  target: TaskRecord | undefined,
  now = new Date(),
  difficultConcepts: string[] = [],
): StudyRecommendation[] {
  if (!courseId || (target && target.courseId !== courseId)) return [];
  const targetWords = new Set((target?.title.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []));
  return materials.filter((material) => material.courseIds.includes(courseId)).map((material) => {
    const reasonCodes: string[] = [];
    let score = 0;
    if (target && material.relatedTargetId === target.id) { score += 100; reasonCodes.push("related_target"); }
    if (target && (material.topics ?? []).some((topic) => (topic.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).some((word) => targetWords.has(word)))) { score += 45; reasonCodes.push("topic_match"); }
    if (target && assessmentKinds.has(target.kind) && practiceTypes.has(material.materialType)) { score += 25; reasonCodes.push("assessment_practice"); }
    const materialWords = new Set(([material.title ?? material.fileName, ...(material.topics ?? [])].join(" ").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []));
    if (difficultConcepts.some(concept => (concept.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).some(word => materialWords.has(word)))) { score += 55; reasonCodes.push("student_difficulty"); }
    if (material.teacherProvided) { score += 15; reasonCodes.push("teacher_provided"); }
    if (material.favorite) { score += 10; reasonCodes.push("pinned"); }
    if (material.lastUsedAt) { score += 5; reasonCodes.push("used_before"); }
    const addedAt = new Date(material.dateAdded).getTime();
    if (Number.isFinite(addedAt) && addedAt <= now.getTime() && now.getTime() - addedAt <= 30 * 86_400_000) { score += 3; reasonCodes.push("recently_added"); }
    if (!reasonCodes.length) reasonCodes.push("same_course");
    return { materialId: material.id, targetId: target?.id ?? null, score, reasonCodes };
  }).sort((a, b) => b.score - a.score || a.materialId.localeCompare(b.materialId));
}

export function aiRerankCandidateIds(recommendations: StudyRecommendation[]): string[] {
  return recommendations.filter((item, index) => item.score <= 45 || recommendations[index - 1]?.score === item.score || recommendations[index + 1]?.score === item.score)
    .map((item) => item.materialId);
}

export function applyAiRerank(recommendations: StudyRecommendation[], rankedIds: string[]): StudyRecommendation[] {
  const candidates = aiRerankCandidateIds(recommendations);
  if (rankedIds.length !== candidates.length || new Set(rankedIds).size !== candidates.length || rankedIds.some((id) => !candidates.includes(id))) return recommendations;
  const byId = new Map(recommendations.map((item) => [item.materialId, item]));
  let position = 0;
  return recommendations.map((item) => candidates.includes(item.materialId) ? byId.get(rankedIds[position++])! : item);
}

export const recommendationReasonLabels: Record<string, string> = {
  student_difficulty: "matches a concept you want to review",
  related_target: "linked to this task",
  topic_match: "matching topic",
  assessment_practice: "assessment practice",
  teacher_provided: "teacher provided",
  pinned: "pinned",
  used_before: "used before",
  recently_added: "recently added",
  same_course: "same course",
};
