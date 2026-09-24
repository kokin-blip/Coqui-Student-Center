import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { StudentCenter } from "../src/StudentCenter";

afterEach(() => vi.unstubAllGlobals());

test("navigation sounds are opt-in and do not play for the current destination", async () => {
  window.history.replaceState({}, "", "/?demo");
  let played = 0;
  class FakeAudioContext {
    currentTime = 0;
    destination = {};
    createOscillator() {
      return {
        type: "sine",
        frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        start() { played += 1; },
        stop() {},
        onended: null as (() => void) | null,
      };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
    close() { return Promise.resolve(); }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  const user = userEvent.setup();
  render(<StudentCenter />);
  const navigation = await screen.findByRole("navigation", { name: "Primary navigation" });
  await user.click(screen.getByRole("button", { name: "Settings" }));
  expect(played).toBe(0);
  await user.click(await screen.findByRole("checkbox", { name: "Navigation sounds" }));
  const reminderSounds = screen.getByRole("checkbox", { name: "Reminder notification sounds" });
  expect(reminderSounds).not.toBeChecked();
  await user.click(reminderSounds);
  expect(reminderSounds).toBeChecked();
  expect(screen.getByText(/Reminder sounds follow your system volume/)).toBeInTheDocument();
  await user.click(withinNavigationButton(navigation, "Today"));
  expect(played).toBe(1);
  await user.click(withinNavigationButton(navigation, "Today"));
  expect(played).toBe(1);
  await user.click(withinNavigationButton(navigation, "Calendar"));
  expect(played).toBe(2);
});

test("weekly task goals are optional and explain their local counting rule", async () => {
  window.history.replaceState({}, "", "/?demo");
  const user = userEvent.setup();
  render(<StudentCenter />);
  await user.click(await screen.findByRole("button", { name:"Settings" }));
  const goal = await screen.findByRole("spinbutton", { name:"Weekly task goal (0 turns off)" });
  expect(goal).toHaveValue(0);
  await user.clear(goal);
  await user.type(goal,"3");
  expect(goal).toHaveValue(3);
  expect(screen.getByText(/Counts tasks completed Monday–Sunday/)).toBeInTheDocument();
});

test("a persisted task completion reaches an opted-in weekly goal", async () => {
  window.history.replaceState({}, "", "/?demo");
  const user = userEvent.setup();
  render(<StudentCenter />);
  await user.click(await screen.findByRole("button", { name:"Settings" }));
  const goal = await screen.findByRole("spinbutton", { name:"Weekly task goal (0 turns off)" });
  await user.clear(goal);
  await user.type(goal,"1");
  await user.click(withinNavigationButton(await screen.findByRole("navigation", { name:"Primary navigation" }), "Work"));
  await user.click(await screen.findByRole("checkbox", { name:/Complete Read Chapter 6: Social Influence/ }));
  expect(await screen.findByText("Your weekly goal is done!")).toBeInTheDocument();
});

function withinNavigationButton(navigation: HTMLElement, name: string) {
  const button = [...navigation.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === name);
  if (!button) throw new Error(`Missing ${name} navigation button`);
  return button;
}
