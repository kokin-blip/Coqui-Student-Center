import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { StudyView } from "../src/components/StudyView";
import * as native from "../src/native";

afterEach(() => vi.restoreAllMocks());

const emptyStudy: native.StudyWorkspace = {
  materials: [],
  artifacts: [],
  reviews: [],
  gradeCategories: [],
  gradeItems: [],
  courseGrades: [],
  gradingScales: [],
};

test("linked course navigation opens the requested Study section and course", async () => {
  const workspace = await native.getLocalWorkspace();
  const course = workspace.courses[0];
  vi.spyOn(native, "getStudyWorkspace").mockResolvedValue(emptyStudy);
  const user = userEvent.setup();
  render(
    <StudyView
      onOpenAssistant={vi.fn()}
      initialCourseId={course.id}
      initialTab="grades"
    />,
  );
  const tabs = await screen.findByRole("navigation", {
    name: "Study sections",
  });
  expect(within(tabs).getByRole("button", { name: "Grades" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await screen.findByLabelText("Course")).toHaveValue(course.id);
  await user.click(within(tabs).getByRole("button", { name: "Materials" }));
  expect(
    screen.getByRole("heading", { name: "Course materials" }),
  ).toBeVisible();
});

test("a failed grounded request clears consent, retains the draft, and does not fall back", async () => {
  const workspace = await native.getLocalWorkspace();
  const course = workspace.courses[0];
  vi.spyOn(native, "getStudyWorkspace").mockResolvedValue({
    ...emptyStudy,
    materials: [
      {
        id: "material-one",
        fileName: "Lecture notes.pdf",
        mime: "application/pdf",
        courseIds: [course.id],
        segmentCount: 3,
      },
    ],
  });
  vi.spyOn(native, "listAiProviders").mockResolvedValue([
    {
      provider: "openai",
      connected: true,
      healthy: true,
      model: "test-model",
      capabilities: ["source_qa"],
      disclosureUrl: "https://example.invalid",
    },
    {
      provider: "anthropic",
      connected: true,
      healthy: true,
      model: "backup-model",
      capabilities: ["source_qa"],
      disclosureUrl: "https://example.invalid",
    },
  ]);
  vi.spyOn(native, "prepareStudyRequest").mockResolvedValue({id:"prepared-one",provider:"openai",model:"test-model",input:{kind:"source_qa",courseIds:[course.id],documentIds:["material-one"],prompt:"Explain the key idea",title:""},sources:[{id:"segment-one",locator:"Page 1",text:"Reviewed source excerpt"}],fingerprint:"scope"});
  const generate = vi
    .spyOn(native, "generateGroundedStudyArtifact")
    .mockRejectedValue(new Error("Provider unavailable"));
  const user = userEvent.setup();
  render(<StudyView onOpenAssistant={vi.fn()} initialCourseId={course.id} />);
  await user.click(
    await screen.findByRole("checkbox", { name: "Lecture notes.pdf" }),
  );
  await user.type(screen.getByLabelText("Request"), "Explain the key idea");
  const consent = screen.getByRole("checkbox", {
    name: /I approve this request/,
  });
  await user.click(screen.getByRole("button", { name: "Review exact request" }));
  await waitFor(() => expect(consent).toBeEnabled());
  await user.click(consent);
  await user.click(screen.getByRole("button", { name: /Create cited result/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The provider was not switched automatically",
  );
  expect(screen.getByLabelText("Request")).toHaveValue("Explain the key idea");
  expect(consent).not.toBeChecked();
  expect(generate).toHaveBeenCalledTimes(1);
});

test("what-if preview reports that it was not saved", async () => {
  const workspace = await native.getLocalWorkspace();
  vi.spyOn(native, "getStudyWorkspace").mockResolvedValue(emptyStudy);
  const preview = vi
    .spyOn(native, "calculateGradeWhatIf")
    .mockResolvedValue({ percent: 92, projectedLetter: "A" });
  const save = vi.spyOn(native, "saveGradeItem");
  const user = userEvent.setup();
  render(
    <StudyView
      onOpenAssistant={vi.fn()}
      initialCourseId={workspace.courses[0].id}
      initialTab="grades"
    />,
  );
  await user.click(await screen.findByText("Add a grade or what-if"));
  await user.type(screen.getByLabelText("Score / what-if"), "92");
  await user.click(screen.getByRole("button", { name: "Preview what-if" }));
  await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
  expect(screen.getByText(/Nothing was saved/)).toBeVisible();
  expect(save).not.toHaveBeenCalled();
});

test("material metadata is editable and organized with persisted filters", async () => {
  const workspace = await native.getLocalWorkspace();
  const course = workspace.courses[0];
  const material: native.StudyMaterial = {
    id: "00000000-0000-4000-8000-000000000301",
    fileName: "lecture-four.pdf",
    title: "Lecture four",
    mime: "application/pdf",
    materialType: "slides",
    courseIds: [course.id],
    topics: ["biomolecules"],
    segmentCount: 8,
    dateAdded: "2026-09-20T12:00:00Z",
    extractionStatus: "complete",
    source: "Professor Rivera",
    favorite: false,
    teacherProvided: true,
  };
  vi.spyOn(native, "getStudyWorkspace").mockResolvedValue({...emptyStudy, materials: [material]});
  const update = vi.spyOn(native, "updateStudyMaterial").mockImplementation(async (input) => ({...emptyStudy, materials: [{...material,...input,id:material.id}]}));
  const user = userEvent.setup();
  render(<StudyView onOpenAssistant={vi.fn()} initialTab="materials" initialCourseId={course.id}/>);

  expect(await screen.findByRole("heading", {name: new RegExp(`${course.code}.*Slides`, "i")})).toBeVisible();
  expect(screen.getByText("biomolecules")).toBeVisible();
  await user.click(screen.getByRole("button", {name:"Edit details"}));
  const editor = screen.getByText("Edit material details").closest(".material-editor")!;
  await user.clear(within(editor).getByLabelText("Title"));
  await user.type(within(editor).getByLabelText("Title"), "Cell chemistry slides");
  await user.selectOptions(within(editor).getByLabelText("Type"), "study_guide");
  await user.type(within(editor).getByLabelText("Topics"), ", protein");
  expect(within(editor).getByLabelText("Topics")).toHaveValue("biomolecules, protein");
  await user.click(within(editor).getByRole("checkbox", {name:"Pin this material"}));
  await user.click(within(editor).getByRole("button", {name:"Save details"}));
  await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({title:"Cell chemistry slides",materialType:"study_guide",favorite:true,teacherProvided:true,topics:["biomolecules","protein"]})));
});

test("recommended materials follow the selected assessment and keep Ask selected materials available", async () => {
  const workspace = await native.getLocalWorkspace();
  const course = workspace.courses[0];
  const dueAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const baseTask = workspace.tasks[0];
  vi.spyOn(native, "getLocalWorkspace").mockResolvedValue({
    ...workspace,
    tasks: [
      { ...baseTask, id: "quiz-one", title: "Biomolecules quiz", kind: "quiz", dueAt },
      { ...baseTask, id: "exam-two", title: "Cells exam", kind: "exam", dueAt },
    ],
  });
  const exact = { id: "exact", fileName: "quiz.pdf", title: "Quiz practice", mime: "application/pdf", courseIds: [course.id], segmentCount: 2, materialType: "previous_quiz" as const, topics: [], relatedTargetId: "quiz-one", dateAdded: "2026-09-01T00:00:00Z", extractionStatus: "complete", source: "", favorite: false, teacherProvided: false };
  const other = { ...exact, id: "other", fileName: "other.pdf", title: "Other class", courseIds: ["different-course"] };
  vi.spyOn(native, "getStudyWorkspace").mockResolvedValue({ ...emptyStudy, materials: [exact, other] });
  const user = userEvent.setup();
  render(<StudyView onOpenAssistant={vi.fn()} initialCourseId={course.id} />);
  const target = await screen.findByRole("combobox", { name: "Study target" });
  await user.selectOptions(target, "quiz-one");
  expect(screen.getByRole("button", { name: /Quiz practice.*linked to this task/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Other class/ })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Ask selected materials" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: /Quiz practice.*linked to this task/ }));
  expect(screen.getByRole("checkbox", { name: "quiz.pdf" })).toBeChecked();
});

test("AI refinement requires consent and preserves deterministic results on failure", async () => {
  const workspace = await native.getLocalWorkspace();
  const course = workspace.courses[0];
  const dueAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  vi.spyOn(native, "getLocalWorkspace").mockResolvedValue({ ...workspace, tasks: [{ ...workspace.tasks[0], id: "quiz", title: "Cells quiz", kind: "quiz", dueAt }] });
  const base: native.StudyMaterial = { id: "notes-a", fileName: "a.pdf", title: "Notes A", mime: "application/pdf", courseIds: [course.id], segmentCount: 2, materialType: "notes", topics: [], dateAdded: "2026-08-01T00:00:00Z", extractionStatus: "complete", source: "", favorite: false, teacherProvided: false };
  vi.spyOn(native, "getStudyWorkspace").mockResolvedValue({ ...emptyStudy, materials: [base, { ...base, id: "notes-b", fileName: "b.pdf", title: "Notes B" }] });
  vi.spyOn(native, "listAiProviders").mockResolvedValue([{ provider: "openai", connected: true, healthy: true, model: "test-model", capabilities: ["study_rerank"], disclosureUrl: "https://example.invalid" }]);
  const rerank = vi.spyOn(native, "rerankStudyMaterials").mockRejectedValue(new Error("Provider unavailable"));
  const user = userEvent.setup();
  render(<StudyView onOpenAssistant={vi.fn()} initialCourseId={course.id} />);
  const refine = await screen.findByRole("button", { name: "Refine uncertain matches with AI" });
  expect(refine).toBeDisabled();
  expect(rerank).not.toHaveBeenCalled();
  await user.click(screen.getByRole("checkbox", { name: "I approve sending this metadata for AI refinement." }));
  await user.click(refine);
  await waitFor(() => expect(rerank).toHaveBeenCalledWith(expect.objectContaining({ courseId: course.id, targetId: "quiz", materialIds: ["notes-a", "notes-b"], consent: true, expectedProvider: "openai", expectedModel: "test-model", sourceScope: JSON.stringify({targetTitle:"Cells quiz",materials:[base,{...base,id:"notes-b",fileName:"b.pdf",title:"Notes B"}].map(m=>({id:m.id,title:m.title,materialType:m.materialType,topics:m.topics}))}) })));
  expect(await screen.findByRole("alert")).toHaveTextContent("Deterministic recommendations remain available");
  expect(screen.getByRole("button", { name: /Notes A/ })).toBeVisible();
  expect(screen.getByRole("button", { name: /Notes B/ })).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "I approve sending this metadata for AI refinement." })).not.toBeChecked();
});
