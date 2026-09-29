import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, expect, test, vi } from "vitest";
import { AutomaticPlanning } from "../src/features/planning/AutomaticPlanning";
import { PlanningSettings } from "../src/features/planning/PlanningSettings";
import { AiSettings } from "../src/features/settings/AiSettings";
import { getPlanningPreferences, savePlanningPreferences, getPlanningStatus, preparePlanning, requestPlanning, validatePlanning, applyPlanning, discardPlanning, type PlanningPreview } from "../src/features/planning/planningApi";
import * as native from "../src/native";

const fixture = vi.hoisted(() => ({ ready: true, fingerprint: "initial", pending: null as PlanningPreview | null }));
vi.mock("../src/features/planning/planningApi", async importOriginal => {
  const original = await importOriginal<typeof import("../src/features/planning/planningApi")>();
  return { ...original,
    getPlanningStatus: vi.fn(async () => { const preferences = await original.getPlanningPreferences(); return { preferences, prompt: fixture.ready && preferences.choice === "undecided", fingerprint: fixture.fingerprint, pending: fixture.pending }; }),
    preparePlanning: vi.fn(async (identifying = false) => ({ token: "scope-token", provider: "openai", model: "fixture-model", disclosureUrl: "https://example.com/terms", facts: { tasks: [{ reference: "work-1", remainingMinutes: 60, ...(identifying ? { title: "Jane's essay" } : {}) }] }, labels: [{ reference: "work-1", title: "Jane's essay", taskId: "task-1" }], includeIdentifying: identifying })),
    requestPlanning: vi.fn(), validatePlanning: vi.fn(), applyPlanning: vi.fn(), discardPlanning: vi.fn(async () => { fixture.pending = null; }),
  };
});
function preview(): PlanningPreview { return { token: "scope-token", reviewId: "review-v1", provider: "openai", model: "fixture-model", labels: [{ reference: "work-1", title: "Jane's essay", taskId: "task-1" }], order: ["work-1"], sessions: [{ reference: "work-1", startsAt: "2030-09-30T17:00:00Z", endsAt: "2030-09-30T18:00:00Z" }], explanation: "Work fits your available afternoon.", before: [], protected: [], excluded: [], outcome: { blocks: [{ taskId: "task-1", title: "Jane's essay", startsAt: "2030-09-30T17:00:00Z", endsAt: "2030-09-30T18:00:00Z" }], overloadConflicts: [], capacity: { plannedMinutes: 60, overloadMinutes: 0 } } }; }
async function openScope() { const user = userEvent.setup(); await user.click(await screen.findByRole("button", { name: "Enable and review access" })); await screen.findByText("openai · fixture-model"); return user; }
beforeEach(() => {
  vi.clearAllMocks(); fixture.ready = true; fixture.fingerprint = "initial"; fixture.pending = null;
  vi.mocked(requestPlanning).mockImplementation(async () => { const result = preview(); fixture.pending = result; return result; });
  vi.mocked(validatePlanning).mockImplementation(async (_token, _order, sessions, excluded) => ({ ...preview(), sessions: sessions ?? preview().sessions, excluded, reviewId: "review-v2" }));
  vi.mocked(applyPlanning).mockImplementation(async () => { fixture.pending = null; return { blocks: [] } as unknown as native.Dashboard; });
});

test("first successful Settings connection prompts; a failed connection does not", async () => {
  fixture.ready = false;
  const connect = vi.spyOn(native, "saveAiProviderKey").mockRejectedValueOnce(new Error("Invalid provider key")).mockImplementationOnce(async () => { fixture.ready = true; window.dispatchEvent(new Event("coqui-planning-settings")); return []; });
  const user = userEvent.setup();
  render(<><AiSettings aiProviders={[]} setAiProviders={vi.fn()} close={vi.fn()} setToast={vi.fn()} /><AutomaticPlanning refreshKey="initial" /></>);
  await user.type(await screen.findByLabelText("API key"), "fixture-key-with-twenty-characters");
  await user.click(screen.getByLabelText(/I am 18 or older/));
  await user.click(screen.getByRole("button", { name: "Validate and connect" }));
  await screen.findByText(/Invalid provider key/); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("API key"), "fixture-key-with-twenty-characters");
  await user.click(screen.getByRole("button", { name: "Validate and connect" }));
  await screen.findByRole("dialog", { name: "Enable AI-assisted automatic planning?" }); expect(requestPlanning).not.toHaveBeenCalled(); connect.mockRestore();
});

test("decline persists across remount and reconnect; reset enables a new choice", async () => {
  const user = userEvent.setup(); const first = render(<AutomaticPlanning refreshKey="initial" />);
  await user.click(await screen.findByRole("button", { name: "No thanks" }));
  expect((await getPlanningPreferences()).choice).toBe("disabled"); first.unmount();
  render(<AutomaticPlanning refreshKey="restart" />); await waitFor(() => expect(getPlanningStatus).toHaveBeenCalledTimes(2));
  act(() => window.dispatchEvent(new Event("coqui-planning-settings"))); await waitFor(() => expect(getPlanningStatus).toHaveBeenCalledTimes(3));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(requestPlanning).not.toHaveBeenCalled();
  await act(() => savePlanningPreferences("undecided")); await screen.findByRole("dialog", { name: "Enable AI-assisted automatic planning?" });
});

test("dismissing the choice declines; onboarding enable shows access without a request", async () => {
  const user = userEvent.setup(); const first = render(<AutomaticPlanning refreshKey="connected" onboarding />);
  await screen.findByRole("dialog"); await user.keyboard("{Escape}"); await waitFor(async () => expect((await getPlanningPreferences()).choice).toBe("disabled")); first.unmount();
  await savePlanningPreferences("undecided"); render(<AutomaticPlanning refreshKey="new" onboarding />);
  await user.click(await screen.findByRole("button", { name: "Enable and review access" }));
  await screen.findByRole("dialog", { name: "Review AI planning access" }); expect(preparePlanning).not.toHaveBeenCalled(); expect(requestPlanning).not.toHaveBeenCalled();
});

test("request consent and separate preview approval gate provider calls and apply", async () => {
  const onDashboard = vi.fn(); const { container } = render(<AutomaticPlanning refreshKey="initial" onDashboard={onDashboard} />); const user = await openScope();
  const send = screen.getByRole("button", { name: "Send facts and create preview" }); expect(send).toBeDisabled(); expect(requestPlanning).not.toHaveBeenCalled();
  await user.click(screen.getByLabelText(/I consent to sending these reviewed facts/)); await user.click(send);
  await screen.findByRole("dialog", { name: "Review proposed plan" }); expect(requestPlanning).toHaveBeenCalledWith("scope-token", true, false, false); expect(applyPlanning).not.toHaveBeenCalled();
  const apply = screen.getByRole("button", { name: "Apply reviewed plan" }); expect(apply).toBeDisabled();
  await user.click(screen.getByLabelText(/I approve applying/)); await user.click(apply);
  expect(applyPlanning).toHaveBeenCalledWith("scope-token", "review-v1", true); expect(onDashboard).toHaveBeenCalled();
  const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } }); expect(results.violations).toEqual([]);
});

test("identifying-data scope requires fresh review and consent", async () => {
  render(<AutomaticPlanning refreshKey="initial" />); const user = await openScope();
  await user.click(screen.getByLabelText(/I consent to sending these reviewed facts/));
  await user.click(screen.getByLabelText(/Include identifying task/));
  await waitFor(() => expect(preparePlanning).toHaveBeenLastCalledWith(true));
  expect(screen.getByRole("button", { name: "Send facts and create preview" })).toBeDisabled();
  await user.click(screen.getByLabelText(/I consent to sending these reviewed facts/)); await user.click(screen.getByRole("button", { name: "Send facts and create preview" }));
  expect(requestPlanning).toHaveBeenCalledWith("scope-token", true, false, true);
});

test("edited times must be validated and consent must be renewed before applying", async () => {
  render(<AutomaticPlanning refreshKey="initial" />); const user = await openScope();
  await user.click(screen.getByLabelText(/I consent to sending these reviewed facts/)); await user.click(screen.getByRole("button", { name: "Send facts and create preview" }));
  await user.click(await screen.findByLabelText(/I approve applying/));
  await user.clear(screen.getByLabelText("Starts")); await user.type(screen.getByLabelText("Starts"), "2030-09-30T12:05");
  await user.click(screen.getByLabelText("Use proposed sessions"));
  expect(screen.getByRole("button", { name: "Apply reviewed plan" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Validate edited preview" }));
  await waitFor(() => expect(validatePlanning).toHaveBeenCalled()); expect(screen.getByLabelText(/I approve applying/)).not.toBeChecked();
  await user.click(screen.getByLabelText(/I approve applying/)); await user.click(screen.getByRole("button", { name: "Apply reviewed plan" }));
  expect(applyPlanning).toHaveBeenCalledWith("scope-token", "review-v2", true);
});

test("eligible changes offer review without sending under default consent", async () => {
  await savePlanningPreferences("enabled"); const view = render(<AutomaticPlanning refreshKey="initial" />);
  await waitFor(() => expect(getPlanningStatus).toHaveBeenCalled()); fixture.fingerprint = "changed-work"; view.rerender(<AutomaticPlanning refreshKey="task-created" />);
  await screen.findByRole("button", { name: "Review AI planning" }); expect(requestPlanning).not.toHaveBeenCalled();
});

test("standing consent coalesces changes and leaves a pending preview; restart does not resend", async () => {
  await savePlanningPreferences("enabled", "standing_deidentified", true); const view = render(<AutomaticPlanning refreshKey="initial" />);
  await waitFor(() => expect(getPlanningStatus).toHaveBeenCalled()); expect(requestPlanning).not.toHaveBeenCalled();
  fixture.fingerprint = "changed"; view.rerender(<AutomaticPlanning refreshKey="first-change" />); view.rerender(<AutomaticPlanning refreshKey="last-change" />);
  await screen.findByRole("button", { name: "Review proposed plan" }); expect(requestPlanning).toHaveBeenCalledTimes(1); expect(requestPlanning).toHaveBeenCalledWith("scope-token", false, true, false); expect(applyPlanning).not.toHaveBeenCalled();
  view.unmount(); render(<AutomaticPlanning refreshKey="restart" />); await screen.findByRole("button", { name: "Review proposed plan" }); expect(requestPlanning).toHaveBeenCalledTimes(1);
});

test("Settings toggles persist and standing consent needs its own confirmation", async () => {
  const user = userEvent.setup(); const view = render(<PlanningSettings />);
  await user.click(await screen.findByLabelText("Enable AI-assisted planning"));
  expect((await getPlanningPreferences()).consentMode).toBe("per_request");
  await user.click(screen.getByLabelText("Allow automatic requests with de-identified planning facts"));
  expect(screen.getByRole("button", { name: "Save standing consent" })).toBeDisabled(); expect((await getPlanningPreferences()).consentMode).toBe("per_request");
  await user.click(screen.getByLabelText(/I authorize these future/)); await user.click(screen.getByRole("button", { name: "Save standing consent" }));
  expect((await getPlanningPreferences()).consentMode).toBe("standing_deidentified"); view.unmount(); render(<PlanningSettings />); expect(await screen.findByLabelText("Allow automatic requests with de-identified planning facts")).toBeChecked();
  await user.click(screen.getByLabelText("Enable AI-assisted planning")); expect((await getPlanningPreferences()).choice).toBe("disabled"); expect((await getPlanningPreferences()).consentMode).toBe("per_request");
});

test("disablement makes an in-flight result unavailable", async () => {
  await savePlanningPreferences("enabled", "standing_deidentified", true);
  let finish!: (value: PlanningPreview) => void; vi.mocked(requestPlanning).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<AutomaticPlanning refreshKey="initial" />); await waitFor(() => expect(getPlanningStatus).toHaveBeenCalled());
  fixture.fingerprint = "changed"; view.rerender(<AutomaticPlanning refreshKey="changed" />); await waitFor(() => expect(requestPlanning).toHaveBeenCalled());
  await act(() => savePlanningPreferences("disabled")); await act(async () => { finish(preview()); });
  expect(screen.queryByRole("button", { name: "Review proposed plan" })).not.toBeInTheDocument(); expect(applyPlanning).not.toHaveBeenCalled();
});

test("discarding a preview makes no calendar change", async () => {
  render(<AutomaticPlanning refreshKey="initial" />); const user = await openScope();
  await user.click(screen.getByLabelText(/I consent to sending these reviewed facts/)); await user.click(screen.getByRole("button", { name: "Send facts and create preview" }));
  await user.click(await screen.findByRole("button", { name: "Discard proposal" })); expect(discardPlanning).toHaveBeenCalled(); expect(applyPlanning).not.toHaveBeenCalled();
});


test("failed requests require renewed consent and never silently retry", async () => {
  vi.mocked(requestPlanning).mockRejectedValue(new Error("Provider quota unavailable; local data unchanged"));
  render(<AutomaticPlanning refreshKey="initial" />); const user = await openScope();
  await user.click(screen.getByLabelText(/I consent to sending these reviewed facts/)); await user.click(screen.getByRole("button", { name: "Send facts and create preview" }));
  await screen.findByText(/Provider quota unavailable/);
  expect(requestPlanning).toHaveBeenCalledTimes(1); expect(applyPlanning).not.toHaveBeenCalled();
  expect(screen.getByLabelText(/I consent to sending these reviewed facts/)).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Send facts and create preview" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Refresh local disclosure" }));
  expect(preparePlanning).toHaveBeenCalledTimes(2); expect(requestPlanning).toHaveBeenCalledTimes(1);
});
