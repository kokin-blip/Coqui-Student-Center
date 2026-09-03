import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import * as native from "../src/native";
import { CoursesView } from "../src/components/CoursesView";
import { TaskDetailsSession } from "../src/features/tasks/TaskDetailsSession";

afterEach(() => vi.restoreAllMocks());
const callbacks = { onDashboard: vi.fn(), onImport: vi.fn(), onStudy: vi.fn() };

test("course-specific instructor drafts do not leak to another course", async () => {
  const workspace = await native.getLocalWorkspace();
  const first = workspace.courses[0];
  const second = {
    ...first,
    id: "course-two",
    code: "ENG 202",
    title: "Second course",
    version: 1,
  };
  vi.spyOn(native, "getLocalWorkspace").mockResolvedValue({
    ...workspace,
    courses: [first, second],
  });
  vi.spyOn(native, "getStudyWorkspace").mockResolvedValue({
    materials: [],
    artifacts: [],
    reviews: [],
    gradeCategories: [],
    gradeItems: [],
    courseGrades: [],
    gradingScales: [],
  });
  const user = userEvent.setup();
  render(
    <TaskDetailsSession>
      <CoursesView {...callbacks} />
    </TaskDetailsSession>,
  );
  await user.click(
    await screen.findByRole("button", { name: /Second course/ }),
  );
  await user.type(
    screen.getByLabelText("Name", { exact: true }),
    "Second-course professor draft",
  );
  await user.click(
    screen.getByRole("button", { name: new RegExp(first.title) }),
  );
  expect(screen.getByLabelText("Name", { exact: true })).toHaveValue("");
  await user.click(screen.getByRole("button", { name: /Second course/ }));
  expect(screen.getByLabelText("Name", { exact: true })).toHaveValue(
    "Second-course professor draft",
  );
});

test("failed course and instructor saves retain their form values", async () => {
  vi.spyOn(native, "createCourse").mockRejectedValueOnce(
    new Error("Course changed; retry"),
  );
  vi.spyOn(native, "createInstructor").mockRejectedValueOnce(
    new Error("Instructor save failed"),
  );
  const user = userEvent.setup();
  render(
    <TaskDetailsSession>
      <CoursesView {...callbacks} />
    </TaskDetailsSession>,
  );
  await user.click(await screen.findByRole("button", { name: "New course" }));
  await user.type(screen.getByLabelText("Course name"), "Unsent course draft");
  await user.click(screen.getByRole("button", { name: "Add course" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Course changed");
  expect(screen.getByLabelText("Course name")).toHaveValue(
    "Unsent course draft",
  );
  await user.click(screen.getByRole("button", { name: "Close" }));
  await user.type(
    await screen.findByLabelText("Name", { exact: true }),
    "Unsent professor draft",
  );
  await user.click(screen.getByRole("button", { name: "Add instructor" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Instructor save failed",
  );
  expect(screen.getByLabelText("Name", { exact: true })).toHaveValue(
    "Unsent professor draft",
  );
});

test("course work opens the selected shared task and linked Study section", async () => {
  const openTask = vi.fn();
  const openStudy = vi.fn();
  const user = userEvent.setup();
  render(
    <TaskDetailsSession>
      <CoursesView
        {...callbacks}
        onOpenTask={openTask}
        onOpenStudy={openStudy}
      />
    </TaskDetailsSession>,
  );
  const nav = await screen.findByRole("tablist", {
    name: "Course sections",
  });
  await user.click(within(nav).getByRole("tab", { name: "Work" }));
  const task = (await native.getLocalWorkspace()).tasks.find(
    (item) => item.courseId,
  );
  if (task) {
    await user.click(await screen.findByRole("button", { name: task.title }));
    expect(openTask).toHaveBeenCalledWith(task.id);
  }
  await user.click(within(nav).getByRole("tab", { name: "Materials" }));
  await user.click(
    await screen.findByRole("button", { name: /course materials/i }),
  );
  await waitFor(() =>
    expect(openStudy).toHaveBeenCalledWith(expect.any(String), "materials"),
  );
});
