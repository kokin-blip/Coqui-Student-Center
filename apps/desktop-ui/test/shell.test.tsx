import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { StudentCenter } from "../src/StudentCenter";
import { THEMES } from "../src/components/ThemeControls";

beforeEach(() => {
  window.history.replaceState({}, "", "/?demo");
});

// vitest's root is apps/desktop-ui. Comments are stripped so prose about a
// retired selector is not mistaken for the selector itself.
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const stylesheets = [
  withoutComments(readFileSync(resolve("src/styles.css"), "utf8")),
  withoutComments(readFileSync(resolve("src/experience-overrides.css"), "utf8")),
];

describe("application shell", () => {
  test("navigation is grouped into Plan, Tools, and Account", async () => {
    render(<StudentCenter />);

    const plan = await screen.findByRole(
      "navigation",
      { name: "Primary navigation" },
      { timeout: 8000 },
    );
    for (const item of ["Today", "Timetable", "Assignments", "Courses"]) {
      expect(within(plan).getByRole("button", { name: item })).toBeInTheDocument();
    }

    const tools = screen.getByRole("navigation", { name: "Tools" });
    for (const item of ["Document vault", "Canvas", "Backups", "Data recovery"]) {
      expect(within(tools).getByRole("button", { name: item })).toBeInTheDocument();
    }

    const account = screen.getByRole("navigation", { name: "Account" });
    for (const item of ["Optional account", "App updates"]) {
      expect(
        within(account).getByRole("button", { name: item }),
      ).toBeInTheDocument();
    }
  });

  test("the selected destination is marked on exactly one nav item", async () => {
    render(<StudentCenter />);
    const plan = await screen.findByRole(
      "navigation",
      { name: "Primary navigation" },
      { timeout: 8000 },
    );
    const active = within(plan)
      .getAllByRole("button")
      .filter((button) => button.classList.contains("active"));
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveAccessibleName("Today");
  });
});

describe("stylesheets", () => {
  // Rules were pinned to [data-theme="dark"], which stopped matching entirely
  // once the themes were renamed — they applied to no theme and nothing failed.
  test("no rule targets a theme that is not shipped", () => {
    const shipped = new Set(THEMES.map((theme) => theme.value));
    for (const sheet of stylesheets) {
      for (const [, theme] of sheet.matchAll(/\[data-theme="([^"]+)"\]/g)) {
        expect(shipped, `[data-theme="${theme}"] is not a shipped theme`).toContain(
          theme,
        );
      }
    }
  });

  test("theme colours are not reintroduced as prefers-color-scheme mirrors", () => {
    for (const sheet of stylesheets) {
      expect(sheet).not.toMatch(/prefers-color-scheme/);
    }
  });
});
