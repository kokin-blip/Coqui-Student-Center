import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  ACCENTS,
  applyAppearance,
  initialAccent,
  initialAppearance,
  normalizeAppearance,
  resolveTheme,
  THEMES,
} from "../src/components/ThemeControls";

const setSystemDark = (dark: boolean) => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: dark && query.includes("dark"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
};

beforeEach(() => setSystemDark(true));

describe("appearance", () => {
  test("every shipped theme and accent lands on the document element", () => {
    for (const theme of THEMES) {
      for (const accent of ACCENTS) {
        applyAppearance(theme.value, accent.value);
        expect(document.documentElement.dataset.accent).toBe(accent.value);
        expect(document.documentElement.dataset.theme).toBe(
          theme.value === "system" ? "coqui-dark" : theme.value,
        );
      }
    }
  });

  test("system resolves against the OS rather than duplicating a theme block", () => {
    setSystemDark(true);
    expect(resolveTheme("system")).toBe("coqui-dark");
    setSystemDark(false);
    expect(resolveTheme("system")).toBe("light");
    // A concrete choice is never overridden by the OS.
    expect(resolveTheme("midnight")).toBe("midnight");
  });

  test("the pre-0.9 dark preference migrates to Coqui Dark", () => {
    expect(normalizeAppearance("dark")).toBe("coqui-dark");
    localStorage.setItem("student-center-appearance", "dark");
    expect(initialAppearance()).toBe("coqui-dark");
  });

  test("unknown stored values fall back instead of breaking the theme", () => {
    localStorage.setItem("student-center-appearance", "chartreuse");
    localStorage.setItem("student-center-accent", "chartreuse");
    expect(initialAppearance()).toBe("system");
    expect(initialAccent()).toBe("green");
  });

  test("appearance and accent round-trip through storage", () => {
    applyAppearance("forest", "purple");
    expect(initialAppearance()).toBe("forest");
    expect(initialAccent()).toBe("purple");
  });
});
