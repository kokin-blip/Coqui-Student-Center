import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test } from "vitest";
import { StudentCenter } from "../src/StudentCenter";

// ?demo puts native.ts into its browser workspace mode with onboarding already
// complete, so the real interface renders without a Tauri host.
beforeEach(() => {
  window.history.replaceState({}, "", "/?demo");
});

// The interface boots through an async bootstrap, and jsdom is slow enough that
// the default 1s query timeout expires before the nav renders.
const timeout = { timeout: 8000 };

// Each destination appears twice: once in the sidebar, once in the mobile nav.
const openTab = async (name: RegExp) => {
  const user = userEvent.setup();
  const [sidebar] = await screen.findAllByRole("button", { name }, timeout);
  await user.click(sidebar);
};

describe("Work and Courses are focused destinations", () => {
  test("Calendar offers day/week views and Canvas connection status", async () => {
    const user = userEvent.setup();
    render(<StudentCenter />);
    await openTab(/^Calendar$/);

    const range = await screen.findByRole("group", { name: "Calendar range" }, timeout);
    expect(screen.getByRole("button", { name: "Canvas · 0" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Day" }));
    expect(within(range).getByRole("button", { name: "Day" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Day calendar" })).toBeInTheDocument();
    expect(screen.getByLabelText("Single-day time grid from 6 AM to 10 PM")).toBeInTheDocument();
  });

  test("Calendar supports keyboard move and resize alternatives", async () => {
    const user = userEvent.setup();
    render(<StudentCenter />);
    await openTab(/^Calendar$/);

    const movable = await screen.findByRole(
      "button",
      { name: /Read Chapter 6: Social Influence.*35 minutes.*flexible/ },
      timeout,
    );
    const originalMoveLabel = movable.getAttribute("aria-label");
    movable.focus();
    await user.keyboard("{ArrowDown}");
    expect(movable.getAttribute("aria-label")).not.toBe(originalMoveLabel);

    const resizable = screen.getByRole("button", {
      name: /Draft research paper introduction.*45 minutes.*flexible/,
    });
    resizable.focus();
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(
      await screen.findByRole("button", {
        name: /Draft research paper introduction.*60 minutes/,
      }),
    ).toBeInTheDocument();
  });

  test("Courses shows course workspaces without global settings or the task editor", async () => {
    const user = userEvent.setup();
    render(<StudentCenter />);
    await openTab(/^Courses$/);

    // h1 is the page title, h2 is the courses panel.
    expect(
      await screen.findByRole("heading", { name: /^Courses$/, level: 2 }, timeout),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Academic terms/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Local profile/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /Assignments & exams/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /Add an assignment or exam/ }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Materials" }));
    expect(screen.getByRole("heading", { name: "Course materials" })).toBeInTheDocument();
    expect(screen.getByText("No course materials yet")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Grades" }));
    expect(screen.getByRole("heading", { name: "Grades and forecast" })).toBeInTheDocument();
    expect(screen.getByText("No grades yet")).toBeInTheDocument();
  });

  test("Work shows filters and its editor without course or planning settings", async () => {
    render(<StudentCenter />);
    await openTab(/^Work$/);

    expect(
      await screen.findByRole(
        "heading",
        { name: /Assignments & exams/ },
        timeout,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Add an assignment or exam/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Work filters" })).toBeInTheDocument();
    expect(screen.getByText(/Coqui chooses the do date/)).toBeInTheDocument();

    expect(
      screen.queryByRole("heading", { name: /Academic terms/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /Local profile/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /Planning preferences/ }),
    ).not.toBeInTheDocument();
  });
});
