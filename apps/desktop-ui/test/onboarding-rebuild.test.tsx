import axe from "axe-core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { OnboardingExperience } from "../src/components/OnboardingExperience";
import type { OnboardingState } from "../src/native";

const state: OnboardingState = {
  required: true,
  onboardingVersion: 2,
  legacyQuarantineStatus: {
    detectedCount: 0,
    quarantineComplete: true,
    recoveryAvailable: false,
  },
  draft: {
    name: "",
    timezone: "America/Phoenix",
    termName: "Current term",
    termStartsOn: "2026-08-01",
    termEndsOn: "2027-05-31",
    courseTitle: "",
    courseCode: "",
    institution: {
      id: "",
      name: "",
      country: "US",
      source: "",
      catalogProviderStatus: "unavailable",
      custom: false,
    },
    courses: [],
    appearance: "light",
    sleepStart: "23:00",
    sleepEnd: "07:00",
    maxSessionMinutes: 60,
    breakMinutes: 10,
    transitionMinutes: 10,
    defaultCommuteMinutes: 0,
    availability: Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      startsAtLocal: "08:00",
      endsAtLocal: "21:00",
    })),
    commitments: [],
  },
};

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-interface-mode");
  vi.restoreAllMocks();
});

test("first-run appearance follows the onboarding draft and remains accessible", async () => {
  document.documentElement.dataset.theme = "dark";
  document.documentElement.dataset.interfaceMode = "compact";
  const user = userEvent.setup();
  const { container } = render(
    <OnboardingExperience
      state={state}
      onState={vi.fn()}
      onComplete={vi.fn()}
    />,
  );

  await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
  expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");

  await user.click(screen.getByRole("button", { name: "Dark" }));
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe("coqui-dark"));
  await user.click(screen.getByRole("button", { name: "Light" }));
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));

  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations).toEqual([]);
});
