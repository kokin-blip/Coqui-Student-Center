import axe from "axe-core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { StudentCenter } from "../src/StudentCenter";

beforeEach(() => {
  window.history.replaceState({}, "", "/?demo");
});

const expectNoAccessibilityViolations = async () => {
  const results = await axe.run(document.body, {
    // jsdom does not perform layout or paint, so it cannot evaluate computed
    // contrast. The production palette is guarded separately by token tests.
    rules: { "color-contrast": { enabled: false } },
  });
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    })),
  ).toEqual([]);
};

test("Today and the primary navigation pass automated accessibility checks", async () => {
  render(<StudentCenter />);
  await screen.findByRole("navigation", { name: "Primary navigation" }, { timeout: 8000 });
  await expectNoAccessibilityViolations();
});

test("Calendar and keyboard-operable planning controls pass automated accessibility checks", async () => {
  const user = userEvent.setup();
  render(<StudentCenter />);
  const navigation = await screen.findByRole(
    "navigation",
    { name: "Primary navigation" },
    { timeout: 8000 },
  );
  await user.click(within(navigation).getByRole("button", { name: "Calendar" }));
  await screen.findByRole("group", { name: "Calendar range" }, { timeout: 8000 });
  await expectNoAccessibilityViolations();
});

test("modal focus handling and schedule review pass automated accessibility checks", async () => {
  const user = userEvent.setup();
  render(<StudentCenter />);
  await user.click(
    await screen.findByRole("button", { name: "Review candidates" }, { timeout: 8000 }),
  );
  const dialog = await screen.findByRole("dialog", undefined, { timeout: 8000 });
  expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();
  await expectNoAccessibilityViolations();
});

test("Work, Courses, Study, and Settings pass automated accessibility checks", async () => {
  const user = userEvent.setup();
  render(<StudentCenter />);
  const navigation = await screen.findByRole(
    "navigation",
    { name: "Primary navigation" },
    { timeout: 8000 },
  );
  for (const destination of ["Work", "Courses", "Study"]) {
    await user.click(within(navigation).getByRole("button", { name: destination }));
    await screen.findByRole("heading", { name: destination, level: 1 }, { timeout: 8000 });
    await expectNoAccessibilityViolations();
  }
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("dialog", { name: "Settings" });
  await expectNoAccessibilityViolations();
});
