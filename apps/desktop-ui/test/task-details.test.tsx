import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { TaskDetailsEditor } from "../src/features/tasks/TaskDetailsEditor";
import { TaskDetailsSession } from "../src/features/tasks/TaskDetailsSession";
import { createPreviewTaskStore } from "../src/features/tasks/taskDetailsApi";
import { StudentCenter } from "../src/StudentCenter";

describe("Task details", () => {
  test("Today and Work share unsaved details across the inspector handoff", async () => {
    window.history.replaceState({}, "", "/?demo");
    const user = userEvent.setup();
    render(<StudentCenter />);
    await user.click(
      await screen.findByRole("button", { name: "Compact", exact: true }),
    );
    const queue = await screen.findByRole("region", { name: "Work queue" });
    await user.click(
      within(queue).getByRole("button", {
        name: "Read Chapter 6: Social Influence",
      }),
    );
    await user.type(
      await screen.findByLabelText("Description", { exact: true }),
      "Carry this draft to Work",
    );
    await user.click(
      screen.getByRole("button", { name: "Edit task", exact: true }),
    );
    expect(
      await screen.findByRole("heading", { name: "Work", exact: true }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("Description", { exact: true })).toHaveValue(
        "Carry this draft to Work",
      ),
    );
    await user.click(
      screen.getByRole("button", { name: "Save details", exact: true }),
    );
    expect(
      await screen.findByText("Saved for this preview session."),
    ).toBeInTheDocument();
  });
  test("save, reopen, ordered subtasks, completion authority and accessible controls", async () => {
    const user = userEvent.setup();
    const view = (id: string, completed = false) => (
      <TaskDetailsSession>
        <TaskDetailsEditor key={id} taskId={id} completed={completed} />
      </TaskDetailsSession>
    );
    const rendered = render(view("one"));
    await user.type(
      await screen.findByLabelText("Description"),
      "My private task notes",
    );
    await user.selectOptions(screen.getByLabelText("Status"), "in_progress");
    await user.type(screen.getByLabelText(/Tags/), "Essay,Writing");
    await user.click(screen.getByRole("button", { name: "Add subtask" }));
    await user.type(
      screen.getByLabelText("Subtask 1", { exact: true }),
      "Find sources",
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Complete subtask 1" }),
    );
    await user.click(screen.getByRole("button", { name: "Save details" }));
    expect(
      await screen.findByText("Saved for this preview session."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Status")).toHaveValue("in_progress");
    rendered.rerender(view("two"));
    await waitFor(() =>
      expect(screen.getByLabelText("Description")).toHaveValue(""),
    );
    rendered.rerender(view("one"));
    await waitFor(() =>
      expect(screen.getByLabelText("Description")).toHaveValue(
        "My private task notes",
      ),
    );
    expect(screen.getByLabelText("Subtask 1", { exact: true })).toHaveValue(
      "Find sources",
    );
    expect(
      screen.getByRole("checkbox", { name: "Complete subtask 1" }),
    ).toBeChecked();
    const result = await axe.run(document.body, {
      rules: {
        "color-contrast": { enabled: false },
        region: { enabled: false },
      },
    });
    expect(result.violations.map((item) => item.id)).toEqual([]);
    rendered.rerender(view("one", true));
    expect(screen.getByText("Completed", { exact: true })).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Completed" }),
    ).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
  });

  test("unsaved work survives selection changes but not a new unlocked session", async () => {
    const user = userEvent.setup();
    const view = (id: string, session = "first") => (
      <TaskDetailsSession key={session}>
        <TaskDetailsEditor key={id} taskId={id} completed={false} />
      </TaskDetailsSession>
    );
    const rendered = render(view("one"));
    await user.type(
      await screen.findByLabelText("Description"),
      "Unfinished outline",
    );
    rendered.rerender(view("two"));
    await waitFor(() =>
      expect(screen.getByLabelText("Description")).toHaveValue(""),
    );
    rendered.rerender(view("one"));
    await waitFor(() =>
      expect(screen.getByLabelText("Description")).toHaveValue(
        "Unfinished outline",
      ),
    );
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument();
    rendered.rerender(view("one", "new"));
    await waitFor(() =>
      expect(screen.getByLabelText("Description")).toHaveValue(""),
    );
  });

  test("blank subtasks do not save and preview revisions reject stale writes", async () => {
    const user = userEvent.setup();
    render(
      <TaskDetailsSession>
        <TaskDetailsEditor taskId="task" completed={false} />
      </TaskDetailsSession>,
    );
    await user.click(
      await screen.findByRole("button", { name: "Add subtask" }),
    );
    await user.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Name each subtask",
    );
    const store = createPreviewTaskStore();
    const input = {
      expectedRevision: 0,
      description: "Saved",
      tags: [],
      progress: "todo" as const,
      subtasks: [],
    };
    await store.save("one", input);
    await expect(store.save("one", input)).rejects.toThrow(
      "Task details changed",
    );
    expect((await store.load("one")).description).toBe("Saved");
  });
});
