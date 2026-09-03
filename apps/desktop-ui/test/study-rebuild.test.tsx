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
  await user.click(consent);
  await user.click(screen.getByRole("button", { name: /Create cited result/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Nothing was sent to another provider",
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
