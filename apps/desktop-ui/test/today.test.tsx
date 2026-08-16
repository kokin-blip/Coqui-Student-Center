import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { StudentCenter } from "../src/StudentCenter";

beforeEach(() => {
  window.history.replaceState({}, "", "/?demo");
});

const timeout = { timeout: 8000 };

describe("Today", () => {
  test("the next best action is present with its duration and controls", async () => {
    render(<StudentCenter />);
    expect(
      await screen.findByText(/your next best action/i, undefined, timeout),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /start this now/i }),
    ).toBeInTheDocument();
  });

  test("capacity reports what fills the day rather than zero statistics", async () => {
    render(<StudentCenter />);
    const capacity = (
      await screen.findByText("Capacity", undefined, timeout)
    ).closest("aside");
    expect(capacity).not.toBeNull();
    const panel = within(capacity as HTMLElement);

    expect(panel.getByText(/available today/)).toBeInTheDocument();
    expect(panel.getByText(/tasks?$/)).toBeInTheDocument();
    expect(panel.getByText(/class(es)?$/)).toBeInTheDocument();
    // Conflict state is words, not just a colour.
    expect(panel.getByText(/no conflicts|conflicts?$/i)).toBeInTheDocument();

    // The old panel rendered "0 completed" and "0 conflicts" on an empty plan.
    expect(panel.queryByText(/^completed$/)).not.toBeInTheDocument();
  });

  test("the greeting follows the time of day", async () => {
    render(<StudentCenter />);
    const heading = await screen.findByRole(
      "heading",
      { name: /^good (morning|afternoon|evening), /i },
      timeout,
    );
    const hour = new Date().getHours();
    const expected =
      hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
    expect(heading.textContent?.toLowerCase()).toContain(expected);
  });
});
