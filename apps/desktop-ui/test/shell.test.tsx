import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { StudentCenter } from "../src/StudentCenter";
import { THEMES } from "../src/components/ThemeControls";
import * as native from "../src/native";

beforeEach(() => {
  window.history.replaceState({}, "", "/?demo");
});

// vitest's root is apps/desktop-ui. Comments are stripped so prose about a
// retired selector is not mistaken for the selector itself.
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const stylesheets = [
  withoutComments(readFileSync(resolve("src/styles.css"), "utf8")),
  withoutComments(
    readFileSync(resolve("src/experience-overrides.css"), "utf8"),
  ),
];

describe("application shell", () => {
  test("finishing setup opens pending schedule imports for review", async () => {
    window.history.replaceState({}, "", "/");
    const initial = await native.initialize();
    const dashboard = await native.getDashboard();
    dashboard.candidates = [{
      id: "setup-quiz",
      documentId: "setup-schedule",
      kind: "task",
      title: "Biology quiz",
      course: "BIO 101",
      dueAt: "2026-10-15T23:59:00Z",
      evidence: "Biology quiz due October 15",
      sourceLocator: "page 1",
      sourceType: "document",
      confidence: 0.95,
      warnings: [],
      status: "pending",
    }];
    const complete = vi.spyOn(native, "completeOnboarding").mockResolvedValue({
      ...initial,
      onboarding: { ...initial.onboarding!, required: false },
      dashboard,
    });
    try {
      const user = userEvent.setup();
      render(<StudentCenter />);
      await user.type(await screen.findByLabelText("What should we call you?"), "Taylor");
      await user.click(screen.getByRole("button", { name: "Continue" }));
      await user.click(screen.getByRole("button", { name: "Skip for now" }));
      await user.click(screen.getByRole("button", { name: "Skip for now" }));
      await user.click(screen.getByRole("button", { name: "Build my first plan" }));

      const review = await screen.findByRole("dialog", { name: "Review extracted facts" });
      expect(within(review).getByText("Biology quiz")).toBeInTheDocument();
      expect(complete).toHaveBeenCalledOnce();
    } finally {
      complete.mockRestore();
    }
  });

  test("navigation exposes the student destinations and keeps administration in Settings", async () => {
    render(<StudentCenter />);

    const plan = await screen.findByRole(
      "navigation",
      { name: "Primary navigation" },
      { timeout: 8000 },
    );
    for (const item of [
      "Today",
      "Calendar",
      "Work",
      "Courses",
      "Study",
      "Semester",
      "Funding",
    ]) {
      expect(
        within(plan).getByRole("button", { name: item }),
      ).toBeInTheDocument();
    }
    expect(
      screen.queryByRole("navigation", { name: "Tools" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "Account" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Settings" }),
    ).toBeInTheDocument();
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

  test("Study exposes grounded learning, materials, and grades without adding sidebar destinations", async () => {
    const user = userEvent.setup();
    render(<StudentCenter />);
    const plan = await screen.findByRole(
      "navigation",
      { name: "Primary navigation" },
      { timeout: 8000 },
    );
    await user.click(within(plan).getByRole("button", { name: "Study" }));
    expect(
      await screen.findByRole("heading", { name: "Study" }),
    ).toBeInTheDocument();
    const sections = screen.getByRole("navigation", { name: "Study sections" });
    for (const item of ["Learn", "Materials", "Grades"])
      expect(
        within(sections).getByRole("button", { name: item }),
      ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", {name:"What to study next"}),
    ).toBeInTheDocument();
  });

  test("Settings uses focused detail routes and restores the opener", async () => {
    const user = userEvent.setup();
    render(<StudentCenter />);
    const settings = await screen.findByRole(
      "button",
      { name: "Settings" },
      { timeout: 8000 },
    );
    await user.click(settings);
    const route = await screen.findByRole("heading", {
      name: "Settings",
      level: 1,
    });
    expect(route.closest('[data-route="settings"]')).toBeInTheDocument();

    const canvas = screen.getByRole("button", { name: /Canvas/ });
    await user.click(canvas);
    const detail = await screen.findByRole("region", {
      name: "Connect Canvas",
    });
    expect(detail.closest("main")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Settings", level: 1 }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Primary navigation" }),
    ).toBeVisible();
    expect(
      within(detail).getByRole("button", { name: "Back to Settings" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("region", { name: "Connect Canvas" }),
    ).not.toBeInTheDocument();
    // The settings home is a real route now, so its controls remount on Back.
    expect(
      screen.getByRole("button", { name: /Canvas Calendar-link/ }),
    ).toHaveFocus();
    await user.click(
      screen.getByRole("button", { name: /Notifications Reminder/ }),
    );
    expect(
      await screen.findByRole("region", { name: "Desktop reminders" }),
    ).toBeInTheDocument();
    await user.click(
      within(
        screen.getByRole("navigation", { name: "Primary navigation" }),
      ).getByRole("button", { name: "Today" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Today", exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Desktop reminders" }),
    ).not.toBeInTheDocument();
  });

  test("changing destinations resets the content scroll position", async () => {
    const user = userEvent.setup();
    render(<StudentCenter />);
    const plan = await screen.findByRole(
      "navigation",
      { name: "Primary navigation" },
      { timeout: 8000 },
    );
    const main = document.querySelector<HTMLElement>(".main");
    expect(main).not.toBeNull();
    main!.scrollTop = 420;
    await user.click(within(plan).getByRole("button", { name: "Calendar" }));
    await waitFor(() => expect(main!.scrollTop).toBe(0));
  });
});

describe("stylesheets", () => {
  test("the shell breakpoints cover wide, icon-rail, and 320px mobile layouts", () => {
    expect(stylesheets.join("\n")).toMatch(/@media\s*\(max-width:\s*1199px\)/);
    expect(stylesheets.join("\n")).toMatch(/@media\s*\(max-width:\s*767px\)/);
    expect(stylesheets.join("\n")).toMatch(
      /@media\s*\(min-width:\s*768px\)\s*and\s*\(max-width:\s*1199px\)/,
    );
    const tauri = JSON.parse(
      readFileSync(resolve("../desktop/src-tauri/tauri.conf.json"), "utf8"),
    );
    expect(tauri.app.windows[0].minWidth).toBe(320);
  });

  // Rules were pinned to [data-theme="dark"], which stopped matching entirely
  // once the themes were renamed — they applied to no theme and nothing failed.
  test("no rule targets a theme that is not shipped", () => {
    const shipped = new Set(THEMES.map((theme) => theme.value));
    for (const sheet of stylesheets) {
      for (const [, theme] of sheet.matchAll(/\[data-theme="([^"]+)"\]/g)) {
        expect(
          shipped,
          `[data-theme="${theme}"] is not a shipped theme`,
        ).toContain(theme);
      }
    }
  });

  test("theme colours are not reintroduced as prefers-color-scheme mirrors", () => {
    for (const sheet of stylesheets) {
      expect(sheet).not.toMatch(/prefers-color-scheme/);
    }
  });

  test("reduced motion removes animated transition timing", () => {
    const css = stylesheets.join("\n");
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(css).toMatch(/animation-duration:\s*\.01ms\s*!important/);
    expect(css).toMatch(/transition-duration:\s*\.01ms\s*!important/);
  });

  // A hardcoded colour cannot follow the theme, so it renders a light-palette
  // value on a dark surface. The brand mark and the onboarding splash are
  // deliberately fixed and are allowed.
  test("colour comes from tokens, not literals", () => {
    const allowed =
      /^\.(logo-|coqui-|onboarding-story|setup-steps|local-promise)/;
    for (const sheet of stylesheets) {
      const offenders: string[] = [];
      for (const block of sheet.split("}")) {
        const [selector = "", body = ""] = block.split("{");
        if (!body || allowed.test(selector.trim())) continue;
        if (/#[0-9a-fA-F]{3,8}\b/.test(body)) {
          offenders.push(
            `${selector.trim().slice(0, 60)} →${body.trim().slice(0, 60)}`,
          );
        }
      }
      expect(offenders, offenders.join("\n")).toHaveLength(0);
    }
  });

  test("text stays at or above the 12px floor", () => {
    for (const sheet of stylesheets) {
      const tooSmall = [...sheet.matchAll(/font-size:\s*(\d+)px/g)]
        .map(([, size]) => Number(size))
        .filter((size) => size < 12);
      expect(tooSmall, `font sizes below 12px: ${tooSmall}`).toHaveLength(0);
    }
  });
});
