import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as native from "../src/native";
import { WorkView } from "../src/components/WorkView";
import { CalendarView } from "../src/components/CalendarView";
import { TaskDetailsSession } from "../src/features/tasks/TaskDetailsSession";
import { StudentCenter } from "../src/StudentCenter";
import { localToIso } from "../src/features/calendar/calendarDate";
import { dateTimeValue } from "../src/features/tasks/taskEditorModel";
import { dayKey } from "../src/features/today/todayModel";

const routeProps = {
  onDashboard: vi.fn(),
  onImport: vi.fn(),
  onStudy: vi.fn(),
};
beforeEach(() => window.history.replaceState({}, "", "/?demo"));
afterEach(() => {
  vi.mocked(native.updateLocalTask).mockRestore?.();
  vi.mocked(native.createCommitment).mockRestore?.();
  vi.mocked(native.getCalendarAgenda).mockRestore?.();
});

describe("Work and Calendar rebuild", () => {
  test("a rejected task save retains core edits and does not reset the inspector", async () => {
    const user = userEvent.setup();
    const saved = (await native.getLocalWorkspace()).tasks[0];
    vi.spyOn(native, "updateLocalTask").mockRejectedValue(
      new Error("Record changed; reload before saving."),
    );
    render(
      <TaskDetailsSession>
        <WorkView
          {...routeProps}
          initialTaskId={saved.id}
          initialFilter="all"
        />
      </TaskDetailsSession>,
    );
    const title = await screen.findByRole("textbox", {
      name: "Task",
      exact: true,
    });
    await waitFor(() => expect(title).toHaveValue(saved.title));
    await user.clear(title);
    await user.type(title, "Keep my unsaved title");
    await user.click(
      screen.getByRole("button", { name: "Save task", exact: true }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Record changed",
    );
    expect(title).toHaveValue("Keep my unsaved title");
    expect(
      screen.getByRole("button", { name: "Save task", exact: true }),
    ).toBeEnabled();
  });

  test("new-task drafts survive selection and returning to New task", async () => {
    const user = userEvent.setup();
    const task = (await native.getLocalWorkspace()).tasks[0];
    render(
      <TaskDetailsSession>
        <WorkView {...routeProps} initialFilter="all" />
      </TaskDetailsSession>,
    );
    await user.type(
      await screen.findByRole("textbox", { name: "Task", exact: true }),
      "New draft, not yet stored",
    );
    await user.click(
      screen.getByRole("button", { name: task.title, exact: true }),
    );
    await user.click(
      screen.getByRole("button", { name: "New task", exact: true }),
    );
    expect(
      screen.getByRole("textbox", { name: "Task", exact: true }),
    ).toHaveValue("New draft, not yet stored");
    expect(
      (await native.getLocalWorkspace()).tasks.some(
        (item) => item.title === "New draft, not yet stored",
      ),
    ).toBe(false);
  });

  test("core drafts and selected records survive Work, Calendar, Today and mode changes", async () => {
    const user = userEvent.setup();
    render(<StudentCenter />);
    const nav = await screen.findByRole("navigation", {
      name: "Primary navigation",
    });
    await user.click(
      within(nav).getByRole("button", { name: "Work", exact: true }),
    );
    const table = await screen.findByRole("region", { name: "Task table" });
    const record = within(table)
      .getAllByRole("button")
      .find((button) => button.getAttribute("aria-pressed") === "false")!;
    const originalTitle = record.textContent!;
    await user.click(record);
    const title = screen.getByRole("textbox", { name: "Task", exact: true });
    await user.clear(title);
    await user.type(title, "Unsaved route handoff");
    await user.click(
      within(nav).getByRole("button", { name: "Calendar", exact: true }),
    );
    expect(
      await screen.findByRole("heading", { name: originalTitle, exact: true }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(
      within(nav).getByRole("button", { name: "Today", exact: true }),
    );
    await user.click(
      screen.getByRole("button", { name: "Compact", exact: true }),
    );
    await user.click(
      within(nav).getByRole("button", { name: "Work", exact: true }),
    );
    expect(
      await screen.findByRole("textbox", { name: "Task", exact: true }),
    ).toHaveValue("Unsaved route handoff");
  });

  test("calendar creation is on demand and a failed save retains its draft", async () => {
    const user = userEvent.setup();
    vi.spyOn(native, "createCommitment").mockRejectedValue(
      new Error("Could not save this event."),
    );
    render(
      <TaskDetailsSession>
        <CalendarView {...routeProps} />
      </TaskDetailsSession>,
    );
    await screen.findByRole("heading", { name: "Week calendar" });
    expect(
      screen.queryByRole("heading", { name: "Add commitment", exact: true }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Add event", exact: true }),
    );
    const dialog = screen.getByRole("dialog", { name: "Calendar event" });
    await user.type(
      within(dialog).getAllByRole("textbox", { name: "Title", exact: true })[0],
      "Protected draft",
    );
    fireEvent.change(
      within(dialog).getAllByLabelText("Starts", { exact: true })[0],
      { target: { value: "2026-09-05T10:00" } },
    );
    fireEvent.change(
      within(dialog).getAllByLabelText("Ends", { exact: true })[0],
      { target: { value: "2026-09-05T11:00" } },
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: "Add commitment",
        exact: true,
      }),
    );
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "Could not save",
      ),
    );
    expect(
      within(dialog).getAllByRole("textbox", { name: "Title", exact: true })[0],
    ).toHaveValue("Protected draft");
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("button", { name: "Add event", exact: true }),
    ).toHaveFocus();
    await user.click(
      screen.getByRole("button", { name: "Add event", exact: true }),
    );
    expect(
      within(screen.getByRole("dialog")).getAllByRole("textbox", {
        name: "Title",
        exact: true,
      })[0],
    ).toHaveValue("Protected draft");
  });

  test("calendar week navigation fetches the chosen range in preview, too", async () => {
    const user = userEvent.setup();
    const fetch = vi.spyOn(native, "getCalendarAgenda");
    render(
      <TaskDetailsSession>
        <CalendarView {...routeProps} />
      </TaskDetailsSession>,
    );
    await screen.findByRole("heading", { name: "Week calendar" });
    await user.click(
      screen.getByRole("button", { name: "Next week", exact: true }),
    );
    await waitFor(() =>
      expect(fetch.mock.calls.at(-1)?.[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/),
    );
    const requested = fetch.mock.calls.at(-1)![0]!;
    const agenda = await native.getCalendarAgenda(requested);
    expect(dayKey(agenda.startsAt, agenda.timezone)).toBe(requested);
  });
});

describe("calendar wall-clock conversion", () => {
  test("handles DST days and rejects nonexistent times instead of shifting them", () => {
    expect(localToIso("2026-03-08", 90, "America/New_York")).toBe(
      "2026-03-08T06:30:00.000Z",
    );
    expect(localToIso("2026-03-08", 210, "America/New_York")).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    expect(() => localToIso("2026-03-08", 150, "America/New_York")).toThrow(
      "clocks change",
    );
    expect(localToIso("2026-09-02", 1440, "America/Phoenix")).toBe(
      "2026-09-03T07:00:00.000Z",
    );
  });
  test("datetime inputs round-trip in the computer timezone without a UTC-prefix shift", () => {
    const instant = new Date(2026, 8, 2, 13, 45).toISOString();
    expect(dateTimeValue(instant)).toBe("2026-09-02T13:45");
    expect(new Date(dateTimeValue(instant)).toISOString()).toBe(instant);
  });
});
