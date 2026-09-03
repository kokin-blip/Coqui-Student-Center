// Development-only synthetic records for reference comparisons. Never imported
// by an installed build, never written to a native profile or sync payload.
import type {
  Dashboard,
  PlanBlock,
  TaskRecord,
  WorkspaceSnapshot,
} from "../../native";

export function fillReferenceFixture(
  kind: string,
  dashboard: Dashboard,
  workspace: WorkspaceSnapshot,
) {
  const compact = kind === "compact";
  const day = compact ? "2025-05-13" : "2025-05-09";
  const timezone = "America/New_York";
  dashboard.planDate = day;
  dashboard.timezone = timezone;
  dashboard.studentName = "María López";
  dashboard.candidates = [];
  dashboard.conflicts = [];
  dashboard.blocks = [];
  workspace.profile = { name: dashboard.studentName, timezone, version: 1 };
  workspace.terms = [
    {
      id: "reference-term",
      name: "Spring 2025",
      startsOn: "2025-01-27",
      endsOn: "2025-05-18",
      active: true,
      version: 1,
    },
  ];
  const titles = compact
    ? ["Calculus I", "CS Principles", "Biology", "World History"]
    : ["English 301: Modern Poetry", "English 302"];
  workspace.courses = titles.map((title, index) => ({
    id: `reference-course-${index}`,
    title,
    code: compact ? title : `English ${301 + index}`,
    termId: "reference-term",
    version: 1,
    recordOrigin: "demo",
    color: "#369668",
  }));
  workspace.classMeetings = [
    {
      id: "reference-meeting",
      courseId: "reference-course-0",
      termId: "reference-term",
      timezone,
      weekdays: [1, 3, 5],
      startsAtLocal: "09:00",
      endsAtLocal: "10:00",
      component: "lecture",
      location: "Hathaway 204",
      modality: "in_person",
      rotationIntervalWeeks: 1,
      rotationOffsetWeeks: 0,
      version: 1,
    },
  ];
  const taskTitles = compact
    ? [
        "Finish Problem Set 4",
        "Review CS quiz notes",
        "Read: Chapter 6 – Photosynthesis",
        "Draft history essay outline",
        "Bio lab report – Part 2",
        "Study group prep",
        "Career fair prep",
        "Update résumé",
        "Apply: STEM Scholarship",
        "Read: The Republic (Book III)",
        "Practice midterm problems",
        "Reflection journal",
      ]
    : [
        "Draft scholarship essay",
        "Creative Writing Portfolio",
        "Scholarship Application: Future Writers Fund",
        "Lit Review Outline",
        "Reading: “The Politics of Story”",
        "Review notes for Friday",
      ];
  workspace.tasks = taskTitles.map(
    (title, index): TaskRecord => ({
      id: `reference-task-${index}`,
      title,
      minutes: index === 0 && compact ? 120 : 45,
      dueAt: compact
        ? `2025-05-${String(13 + Math.floor(index / 2)).padStart(2, "0")}`
        : [undefined, "2025-05-12", "2025-05-15", "2025-05-20"][index],
      courseId:
        index === 2 && !compact
          ? undefined
          : `reference-course-${index % titles.length}`,
      priority: index < 2 ? 5 : 3,
      academicRisk: index < 3 ? 4 : 2,
      energyDemand: "medium",
      location: "",
      splittable: true,
      minSessionMinutes: 25,
      maxSessionMinutes: 60,
      completed: false,
      version: 1,
      dependencies: [],
      recordOrigin: "demo",
      kind: "assignment",
    }),
  );
  const add = (
    date: string,
    title: string,
    start: string,
    end: string,
    kind: PlanBlock["kind"],
    location = "",
    task?: number,
    completed = false,
  ) =>
    dashboard.blocks.push({
      id: `reference-block-${dashboard.blocks.length}`,
      title,
      startsAt: `${date}T${start}:00-04:00`,
      endsAt: `${date}T${end}:00-04:00`,
      kind,
      location,
      taskId: task === undefined ? undefined : `reference-task-${task}`,
      completed,
      locked: kind !== "study",
      sessionIndex: 0,
      reasonCodes: [],
      ...(task === 0 ? { startedAt: `${date}T${start}:00-04:00` } : {}),
    });
  if (compact) {
    for (let i = 0; i < 5; i++) {
      const date = `2025-05-${12 + i}`;
      add(
        date,
        i % 2 ? "CS Principles" : "Calculus",
        "08:30",
        "09:50",
        "class",
      );
      add(date, i % 2 ? "Calculus" : "Bio Lab", "10:00", "12:00", "class");
      add(
        date,
        i % 2 ? "History" : "Work",
        "13:00",
        i % 2 ? "14:20" : "16:00",
        "work",
      );
      add(
        date,
        i % 2 ? "Focus time" : "Study block",
        "18:00",
        "20:00",
        "study",
        "",
        i,
      );
    }
    add("2025-05-17", "Work", "09:00", "12:00", "work");
  } else {
    add(day, "Morning routine", "08:00", "08:30", "life", "", undefined, true);
    add(day, titles[0], "09:00", "10:00", "class", "Hathaway 204");
    add(day, "Office hours", "10:05", "11:00", "class", "Professor Lin");
    add(
      day,
      "Library research",
      "11:05",
      "12:00",
      "work",
      "Main Library · 3rd Floor",
    );
    add(
      day,
      "Creative Writing Workshop",
      "13:00",
      "14:00",
      "class",
      "Hathaway 305",
    );
    add(
      day,
      "Meet with study group",
      "14:10",
      "15:20",
      "life",
      "Main Library · Room 312",
    );
    add(day, taskTitles[4], "16:00", "16:55", "study", "45 min focus", 4);
    add(day, taskTitles[5], "17:00", "17:55", "study", "30 min", 5);
  }
  // Give the next-action control a real linked fixture block.
  const focus = compact
    ? dashboard.blocks.find((b) => b.taskId === "reference-task-0")!
    : dashboard.blocks.find((b) => b.taskId === "reference-task-4")!;
  dashboard.nextAction = {
    blockId: focus.id,
    taskId: focus.taskId!,
    title: focus.title,
    durationMinutes: 45,
    explanation: "Make progress on your next planned task.",
    reasonCodes: ["deadline_soon"],
    alternatives: [],
    validFrom: focus.startsAt,
    validUntil: focus.endsAt,
  };
  workspace.commitments = [];
}
