import { render, screen } from "@testing-library/react";
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

describe("Assignments and Courses are distinct screens", () => {
  test("Courses shows courses, terms, and preferences but not the task editor", async () => {
    render(<StudentCenter />);
    await openTab(/^Courses$/);

    expect(
      await screen.findByRole("heading", { name: /Academic terms/ }, timeout),
    ).toBeInTheDocument();
    // h1 is the page title, h2 is the courses panel.
    expect(
      screen.getByRole("heading", { name: /^Courses$/, level: 2 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Local profile/ }),
    ).toBeInTheDocument();

    expect(
      screen.queryByRole("heading", { name: /Assignments & exams/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /Add an assignment or exam/ }),
    ).not.toBeInTheDocument();
  });

  test("Assignments shows the task list and editor but not courses or preferences", async () => {
    render(<StudentCenter />);
    await openTab(/^Assignments$/);

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
