import axe from "axe-core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { OnboardingExperience } from "../src/components/OnboardingExperience";
import type { OnboardingState } from "../src/native";
import * as native from "../src/native";

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
  expect(screen.getByText("© 2026 Erick X. Martinez")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Dark" }));
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe("coqui-dark"));
  await user.click(screen.getByRole("button", { name: "Light" }));
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));

  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations).toEqual([]);
});

test("weekly rhythm captures recurring anchors as editable structured rules", async () => {
  const user = userEvent.setup();
  render(
    <OnboardingExperience
      state={state}
      onState={vi.fn()}
      onComplete={vi.fn()}
    />,
  );

  await user.type(screen.getByLabelText("What should we call you?"), "Taylor");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  await user.click(screen.getByRole("button", { name: "Skip for now" }));

  expect(screen.getByRole("group", { name: "Preferred study windows" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Add time" }));
  expect(screen.getByLabelText("Weekly anchor 1 type")).toHaveValue("recurring_obligation");
  await user.selectOptions(screen.getByLabelText("Weekly anchor 1 type"), "work");
  await user.clear(screen.getByLabelText("Label"));
  await user.type(screen.getByLabelText("Label"), "Library shift");
  expect(screen.getByRole("button", { name: "Remove Library shift" })).toBeInTheDocument();
});

test("a failed optional syllabus import still finishes setup with pending reviews", async () => {
  const dashboard = await native.getDashboard();
  dashboard.candidates = [{
    id: "setup-quiz",
    documentId: "setup-schedule",
    kind: "task",
    title: "Biology quiz",
    course: "BIO 101",
    evidence: "Biology quiz due October 15",
    sourceLocator: "page 1",
    sourceType: "document",
    confidence: 0.95,
    warnings: [],
    status: "pending",
  }];
  vi.spyOn(native, "completeOnboarding").mockResolvedValue({
    security: { pinEnabled: false, locked: false, retryAfterSeconds: 0 },
    schemaVersion: 29,
    onboarding: { ...state, required: false },
    dashboard,
  });
  vi.spyOn(native, "selectAndImport").mockRejectedValue(new Error("Could not read syllabus"));
  const onComplete = vi.fn();
  const user = userEvent.setup();
  render(<OnboardingExperience state={state} onState={vi.fn()} onComplete={onComplete} />);

  await user.type(screen.getByLabelText("What should we call you?"), "Taylor");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  await user.click(screen.getByRole("checkbox", { name: /Choose my first syllabus after setup/ }));
  await user.click(screen.getByRole("button", { name: "Build my first plan" }));

  await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
  const result = onComplete.mock.calls[0][0];
  expect(result.dashboard.candidates[0].status).toBe("pending");
  expect(result.dashboard.importNotice).toContain("Could not read syllabus");
});
