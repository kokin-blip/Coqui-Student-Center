import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { StudentCenter } from "../src/StudentCenter";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";

beforeEach(() => {
  window.history.replaceState({}, "", "/?demo");
});

const timeout = { timeout: 8000 };

describe("Today", () => {
  test("the next best action is present with its duration and controls", async () => {
    render(<StudentCenter />);
    expect(
      await screen.findByText(/your next step/i, undefined, timeout),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /start focus/i }),
    ).toBeInTheDocument();
  });

  test("capacity reports free availability, not scheduled time", async () => {
    render(<StudentCenter />);
    const capacity = await screen.findByRole(
      "region",
      { name: "Today's capacity" },
      timeout,
    );
    expect(capacity).not.toBeNull();
    const panel = within(capacity as HTMLElement);

    expect(
      panel.getByText(/remaining free time|set availability/i),
    ).toBeInTheDocument();
    expect(panel.getByText(/tasks? · .*classes/)).toBeInTheDocument();
    // Conflict state is words, not just a colour.
    expect(panel.getByText(/no conflicts|conflicts?$/i)).toBeInTheDocument();

    // The old panel rendered "0 completed" and "0 conflicts" on an empty plan.
    expect(panel.queryByText(/^completed$/)).not.toBeInTheDocument();
  });

  test("the reference heading and timeline date are present", async () => {
    render(<StudentCenter />);
    const heading = await screen.findByRole(
      "heading",
      { name: "Today", level: 1 },
      timeout,
    );
    expect(heading).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Daily timeline" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/All times in/)).toHaveTextContent(
      "America/Phoenix",
    );
  });

  test("Compact changes composition, selects real tasks, and restores focus from its drawer", async () => {
    const user = userEvent.setup();
    render(<StudentCenter />);
    await user.click(
      await screen.findByRole("button", { name: "Compact", exact: true }),
    );
    expect(
      await screen.findByRole("region", { name: "Weekly schedule" }),
    ).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("coqui-dark");
    const queue = screen.getByRole("region", { name: "Work queue" });
    const task = within(queue).getByRole("button", {
      name: "Read Chapter 6: Social Influence",
    });
    await user.click(task);
    const dialog = await screen.findByRole("dialog", {
      name: "Task inspector",
    });
    expect(
      within(dialog).getByRole("heading", {
        name: "Read Chapter 6: Social Influence",
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Close", exact: true }),
    ).toHaveFocus();
    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations.map((v) => v.id)).toEqual([]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(task).toHaveFocus();
    await user.click(
      screen.getByRole("button", { name: "Comfy", exact: true }),
    );
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(
      screen.getByRole("region", { name: "Daily timeline" }),
    ).toBeInTheDocument();
  });

  test("setup dismissal survives remount and the schedule list exposes complete labels", async () => {
    const user = userEvent.setup();
    const rendered = render(<StudentCenter />);
    await user.click(
      await screen.findByRole("button", { name: "Dismiss setup checklist" }),
    );
    rendered.unmount();
    render(<StudentCenter />);
    await screen.findByRole("region", { name: "Daily timeline" });
    expect(
      screen.queryByRole("region", { name: "Finish setting up" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show list" }));
    expect(
      screen.getByRole("button", { name: /9 AM–9:50 AM Statistics 201/ }),
    ).toBeInTheDocument();
  });
});
