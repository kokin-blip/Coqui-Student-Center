import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import axe from "axe-core";
import * as native from "../src/native";
import { BrightspaceSettings } from "../src/features/settings/BrightspaceSettings";
import { ReviewDialog } from "../src/features/overlays/ReviewDialogs";
import { PlanningDialogs } from "../src/features/overlays/PlanningDialogs";
import { StudentCenter } from "../src/StudentCenter";

beforeEach(() => {
  window.history.replaceState({}, "", "/?demo");
  window.matchMedia = query => ({ matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });
});
afterEach(() => vi.restoreAllMocks());
const event: native.ImportCandidate = {
  id: "brightspace-event", documentId: "brightspace-file", kind: "commitment", title: "Study group", course: "BIO 101",
  startsAt: "2026-10-02T16:00:00Z", endsAt: "2026-10-02T17:00:00Z", evidence: "SUMMARY:Study group · DTSTART:20261002T090000",
  sourceLocator: "Brightspace calendar · calendar event group", sourceType: "brightspace_calendar", confidence: 1, warnings: [], status: "pending",
};
const callbacks = () => ({ close: vi.fn(), onDashboard: vi.fn(), onToast: vi.fn(), onReview: vi.fn() });

test("guidance describes snapshots, formats and local privacy accessibly", async () => {
  const data = await native.getDashboard();
  const { container } = render(<BrightspaceSettings data={{ ...data, candidates: [] }} {...callbacks()} />);
  expect(screen.getByText(/no live Brightspace API/)).toBeInTheDocument();
  expect(screen.getByText(/25 MB/)).toBeInTheDocument();
  expect(screen.getByText(/Images and scanned PDFs need local OCR/)).toBeInTheDocument();
  expect(screen.getByText(/ZIP course packages, IMSCC/)).toBeInTheDocument();
  expect(screen.getByLabelText("Assignment spreadsheet example")).toHaveTextContent("title,course,due_date");
  expect((await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
});

test("cancellation, failure and empty-read retry keep controls usable", async () => {
  const data = { ...await native.getDashboard(), candidates: [] };
  const props = callbacks();
  const select = vi.spyOn(native, "selectAndImportBrightspace").mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("Unsupported course package")).mockResolvedValueOnce({ documentId: "file", dashboard: { ...data, importNotice: "No academic dates found; original encrypted." } });
  const user = userEvent.setup();
  render(<BrightspaceSettings data={data} {...props} />);
  const button = screen.getByRole("button", { name: "Choose Brightspace file" });
  await user.click(button);
  expect(props.onDashboard).not.toHaveBeenCalled();
  await user.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported course package");
  expect(button).toBeEnabled();
  await user.click(button);
  await waitFor(() => expect(props.onDashboard).toHaveBeenCalledOnce());
  expect(props.onReview).not.toHaveBeenCalled();
  expect(props.onToast).toHaveBeenCalledWith("No academic dates found; original encrypted.");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(select).toHaveBeenCalledTimes(3);
});

test("reading disables import and duplicates reopen pending source", async () => {
  const data = { ...await native.getDashboard(), candidates: [event] };
  const props = callbacks();
  let finish!: (result: native.DocumentImportResult) => void;
  vi.spyOn(native, "selectAndImportBrightspace").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const user = userEvent.setup();
  render(<BrightspaceSettings data={data} {...props} />);
  await user.click(screen.getByRole("button", { name: "Choose Brightspace file" }));
  expect(screen.getByRole("button", { name: "Reading file…" })).toBeDisabled();
  finish({ documentId: "brightspace-file", dashboard: { ...data, importNotice: "This file already exists; no duplicate was created." } });
  await waitFor(() => expect(props.onReview).toHaveBeenCalledWith("brightspace-file"));
  expect(props.onToast).toHaveBeenCalledWith("This file already exists; no duplicate was created.");
});

test("review retains evidence, editing, destinations and explicit decisions", async () => {
  const user = userEvent.setup();
  const decide = vi.fn(), close = vi.fn(), linked = vi.fn();
  const editing = vi.spyOn(native, "updateImportCandidate").mockResolvedValue(await native.getDashboard());
  vi.spyOn(native, "getScheduleSourcePreview").mockRejectedValue(new Error("Review the extracted evidence beside it."));
  render(<ReviewDialog candidates={[event]} selectedIds={[event.id]} linkedTaskCandidateIds={[]} canvasScoped={false} sourceProvider="Brightspace" conflictedIds={new Set()} busy={false} terms={[]} hasSourceChanges={false} close={close} openConflicts={vi.fn()} onSelection={vi.fn()} onLinkedTaskSelection={linked} onDashboard={vi.fn()} onError={vi.fn()} decide={decide} />);
  expect(screen.getByRole("heading", { name: "Review Brightspace imports" })).toBeInTheDocument();
  expect(screen.getByText("Brightspace source evidence")).toBeInTheDocument();
  expect(screen.getByText(event.evidence)).toBeInTheDocument();
  expect(screen.getByText("Destination: Calendar")).toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: "Also add a linked to-do in Work" }));
  expect(linked).toHaveBeenCalledWith([event.id]);
  await user.click(screen.getByRole("button", { name: "Edit fields" }));
  const title = screen.getByLabelText("Title");
  await user.clear(title);
  await user.type(title, "Edited study group");
  await user.click(screen.getByRole("button", { name: /Save candidate/ }));
  expect(editing).toHaveBeenCalledWith(event.id, expect.objectContaining({ title: "Edited study group" }));
  await user.click(screen.getByRole("button", { name: "Keep for later" }));
  expect(close).toHaveBeenCalledOnce();
  expect(decide).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Ignore selected" }));
  await user.click(screen.getByRole("button", { name: "Approve and plan" }));
  expect(decide.mock.calls).toEqual([["reject"], ["approve"]]);
});

for (const choice of ["approve", "reject", "later"] as const) {
  test(`shell scopes Brightspace ${choice} to its imported document`, async () => {
    const data = await native.getDashboard();
    const result = { ...data, candidates: [...data.candidates, event], unsettledScheduleSources: [] };
    vi.spyOn(native, "selectAndImportBrightspace").mockResolvedValue({ dashboard: result, documentId: event.documentId });
    const applied = vi.spyOn(native, "applyImportReview").mockResolvedValue({ ...result, candidates: result.candidates.map(item => item.id === event.id ? { ...item, status: "approved" as const } : item) });
    const rejected = vi.spyOn(native, "rejectCandidates").mockResolvedValue({ ...result, candidates: result.candidates.map(item => item.id === event.id ? { ...item, status: "rejected" as const } : item) });
    const user = userEvent.setup();
    render(<StudentCenter />);
    await user.click(await screen.findByRole("button", { name: "Settings" }, { timeout: 8000 }));
    await user.click(await screen.findByRole("button", { name: /Brightspace Downloaded/ }));
    await user.click(await screen.findByRole("button", { name: "Choose Brightspace file" }));
    const dialog = await screen.findByRole("dialog", { name: "Review Brightspace imports" });
    expect(within(dialog).queryByText("Paper", { selector: "strong" })).not.toBeInTheDocument();
    expect(applied).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();
    if (choice === "approve") {
      await user.click(within(dialog).getByRole("checkbox", { name: "Also add a linked to-do in Work" }));
      await user.click(within(dialog).getByRole("button", { name: "Approve and plan" }));
      await waitFor(() => expect(applied).toHaveBeenCalledWith([{ candidateId: event.id, createLinkedTask: true }]));
    } else if (choice === "reject") {
      await user.click(within(dialog).getByRole("button", { name: "Ignore selected" }));
      await waitFor(() => expect(rejected).toHaveBeenCalledWith([event.id]));
    } else {
      await user.click(within(dialog).getByRole("button", { name: "Keep for later" }));
      expect(applied).not.toHaveBeenCalled();
      expect(rejected).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Review Brightspace source 1" }));
      expect(await screen.findByRole("dialog", { name: "Review Brightspace imports" })).toBeInTheDocument();
    }
  });
}

test("schedule import offers the Brightspace shortcut with keyboard access", async () => {
  const user = userEvent.setup();
  render(<StudentCenter />);
  await user.click(within(await screen.findByRole("navigation", { name: "Primary navigation" }, { timeout: 8000 })).getByRole("button", { name: "Calendar", exact: true }));
  await user.click(await screen.findByRole("button", { name: "Import schedule" }));
  const button = await screen.findByRole("button", { name: /Brightspace file Import/ });
  button.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("heading", { name: "Import Brightspace" })).toBeInTheDocument();
});


test("Brightspace critical-date review names its source provider", async () => {
  const user = userEvent.setup();
  const data = await native.getDashboard();
  const resolve = vi.fn();
  render(<PlanningDialogs active="conflicts" dashboard={{ ...data, candidates: [event], conflicts: [{ id: "brightspace-conflict", kind: "source_change", description: "The source date changed", candidateId: event.id, entityType: "commitment", currentStartsAt: event.startsAt, currentEndsAt: event.endsAt, proposedStartsAt: "2026-10-03T16:00:00Z", proposedEndsAt: "2026-10-03T17:00:00Z" }] }} busy={false} replanReason="" close={vi.fn()} openReplan={vi.fn()} setReplanReason={vi.fn()} resolveConflict={resolve} submitReplan={vi.fn()} />);
  expect(screen.getByText("Newest Brightspace value")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Use Brightspace value" }));
  expect(resolve).toHaveBeenCalledWith("brightspace-conflict", "use_source", "Brightspace value accepted and plan rebuilt.");
});
