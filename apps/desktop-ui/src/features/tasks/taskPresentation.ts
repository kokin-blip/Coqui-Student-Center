const reasonLabels: Record<string, string> = {
  assessment_final: "Final assessment",
  assessment_midterm: "Midterm assessment",
  assessment_exam: "Exam",
  assessment_test: "Test",
  assessment_quiz: "Quiz",
  project_work: "Project",
  paper_work: "Paper or essay",
  lab_work: "Lab",
  homework_work: "Homework",
  reading_work: "Reading",
  unclassified_work: "No assessment keyword found",
  overdue: "Overdue",
  due_within_24_hours: "Due within 24 hours",
  due_within_3_days: "Due within 3 days",
  student_selected: "Set by you",
};

export const priorityName = (priority: number) =>
  priority >= 5
    ? "Very high"
    : priority === 4
      ? "High"
      : priority === 3
        ? "Medium"
        : priority === 2
          ? "Low"
          : "Very low";

export const taskKindName = (kind: string) =>
  kind.replaceAll("_", " ").replace(/(^|\s)\S/g, (value) => value.toUpperCase());

export const priorityReasonLabel = (reason: string) =>
  reasonLabels[reason] ?? taskKindName(reason);
