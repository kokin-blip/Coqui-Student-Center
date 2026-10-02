import { expect, test } from "vitest";
import type { StudyMaterial, TaskRecord } from "../src/native";
import { aiRerankCandidateIds, applyAiRerank, recommendStudyMaterials, studyTargets } from "../src/features/study/recommendations";

const now = new Date("2026-09-22T12:00:00Z");
const task = (id: string, courseId: string, kind: TaskRecord["kind"], dueAt: string): TaskRecord => ({
  id, courseId, kind, dueAt, title: `${kind} biomolecules`, minutes: 60, priority: 3,
  academicRisk: 0, energyDemand: "medium", location: "", splittable: true,
  minSessionMinutes: 20, maxSessionMinutes: 60, completed: false, version: 1,
  dependencies: [], recordOrigin: "test", prioritySource: "rules", priorityReasonCodes: [], effortSource: "student",
});

test("AI can reorder only uncertain positions and cannot inject a material", () => {
  const recommendations = [
    { materialId: "exact", targetId: "quiz", score: 100, reasonCodes: ["related_target"] },
    { materialId: "weak-a", targetId: "quiz", score: 10, reasonCodes: ["pinned"] },
    { materialId: "weak-b", targetId: "quiz", score: 5, reasonCodes: ["used_before"] },
  ];
  expect(aiRerankCandidateIds(recommendations)).toEqual(["weak-a", "weak-b"]);
  expect(applyAiRerank(recommendations, ["weak-b", "weak-a"]).map((item) => item.materialId)).toEqual(["exact", "weak-b", "weak-a"]);
  expect(applyAiRerank(recommendations, ["weak-b", "outside-course"])).toEqual(recommendations);
  expect(applyAiRerank(recommendations, ["weak-b", "weak-b"])).toEqual(recommendations);
});
const material = (id: string, courseId: string, changes: Partial<StudyMaterial> = {}): StudyMaterial => ({
  id, fileName: `${id}.pdf`, mime: "application/pdf", courseIds: [courseId], segmentCount: 2,
  title: id, materialType: "notes", topics: [], dateAdded: "2026-08-01T00:00:00Z",
  extractionStatus: "complete", source: "", favorite: false, teacherProvided: false, ...changes,
});

test("the next upcoming assessment becomes the default target", () => {
  const targets = studyTargets([
    task("homework", "biology", "homework", "2026-09-23T12:00:00Z"),
    task("quiz", "biology", "quiz", "2026-09-24T12:00:00Z"),
    task("other-course", "chemistry", "exam", "2026-09-23T12:00:00Z"),
    task("past", "biology", "exam", "2026-09-01T12:00:00Z"),
  ], "biology", now);
  expect(targets.map((item) => item.id)).toEqual(["quiz", "homework"]);
});

test("ranking favors exact links and topics but never leaks across courses", () => {
  const quiz = task("quiz", "biology", "quiz", "2026-09-24T12:00:00Z");
  const results = recommendStudyMaterials([
    material("teacher", "biology", { teacherProvided: true }),
    material("exact", "biology", { relatedTargetId: quiz.id }),
    material("topic", "biology", { topics: ["biomolecules"], materialType: "previous_quiz" }),
    material("other", "chemistry", { relatedTargetId: quiz.id, teacherProvided: true }),
  ], "biology", quiz, now);
  expect(results.map((item) => item.materialId)).toEqual(["exact", "topic", "teacher"]);
  expect(results[0].reasonCodes).toContain("related_target");
  expect(results[1].reasonCodes).toContain("topic_match");
  expect(results[1].reasonCodes).toContain("assessment_practice");
  expect(recommendStudyMaterials([material("other", "chemistry")], "biology", task("wrong", "chemistry", "quiz", "2026-09-24T12:00:00Z"), now)).toEqual([]);
});

test("student-authored difficult concepts boost only matching materials in that course",()=>{
 const materials=[material("topic","biology",{topics:["Recursion"]}),material("other","chemistry",{topics:["Recursion"]}),material("general","biology",{teacherProvided:true})];
 const result=recommendStudyMaterials(materials,"biology",undefined,now,["recursion"]);
 expect(result.map(r=>r.materialId)).toEqual(["topic","general"]);
 expect(result[0].reasonCodes).toContain("student_difficulty");
 expect(recommendStudyMaterials(materials,"biology",undefined,now,[])[0].materialId).toBe("general");
});
