import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test } from "vitest";
import { StudentCenter } from "../src/StudentCenter";
import { ACCENTS, THEMES } from "../src/components/ThemeControls";

beforeEach(() => {
  window.history.replaceState({}, "", "/?demo");
});

const timeout = { timeout: 8000 };

const openSettings = async () => {
  const user = userEvent.setup();
  const [settings] = await screen.findAllByRole(
    "button",
    { name: "Settings" },
    timeout,
  );
  await user.click(settings);
  return user;
};

describe("appearance settings", () => {
  test("every shipped theme and accent is reachable from the interface", async () => {
    render(<StudentCenter />);
    await openSettings();

    const themes = await screen.findByRole("radiogroup", { name: "Theme" });
    for (const theme of THEMES) {
      expect(
        within(themes).getByRole("radio", { name: new RegExp(theme.label) }),
      ).toBeInTheDocument();
    }

    const accents = screen.getByRole("radiogroup", { name: "Accent color" });
    for (const accent of ACCENTS) {
      expect(
        within(accents).getByRole("radio", { name: accent.label }),
      ).toBeInTheDocument();
    }
  });

  test("picking a theme applies it and marks exactly one option", async () => {
    render(<StudentCenter />);
    const user = await openSettings();

    const themes = await screen.findByRole("radiogroup", { name: "Theme" });
    await user.click(within(themes).getByRole("radio", { name: /Midnight/ }));

    expect(document.documentElement.dataset.theme).toBe("midnight");
    expect(
      within(themes)
        .getAllByRole("radio")
        .filter((option) => option.getAttribute("aria-checked") === "true"),
    ).toHaveLength(1);
  });

  test("accent is independent of theme", async () => {
    render(<StudentCenter />);
    const user = await openSettings();

    const themes = await screen.findByRole("radiogroup", { name: "Theme" });
    await user.click(within(themes).getByRole("radio", { name: /Forest/ }));

    const accents = screen.getByRole("radiogroup", { name: "Accent color" });
    await user.click(within(accents).getByRole("radio", { name: "Purple" }));

    // Choosing an accent must not reset the theme.
    expect(document.documentElement.dataset.theme).toBe("forest");
    expect(document.documentElement.dataset.accent).toBe("purple");
  });

  test("Settings and App lock are separate destinations", async () => {
    render(<StudentCenter />);
    await screen.findAllByRole("button", { name: "Settings" }, timeout);
    expect(
      screen.getByRole("button", { name: "App lock" }),
    ).toBeInTheDocument();
  });
});
