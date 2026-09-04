import axe from "axe-core";
import { createRef, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { AssistantDialog } from "../src/features/overlays/AssistantDialog";
import { DeleteProfileDialog } from "../src/features/overlays/DeleteProfileDialog";
import { ImportDialog } from "../src/features/overlays/ImportDialog";
import { PlanningDialogs } from "../src/features/overlays/PlanningDialogs";
import {
  CalendarRefreshDialog,
  RetentionDialog,
  ReviewDialog,
} from "../src/features/overlays/ReviewDialogs";
import type { Dashboard } from "../src/native";

const dashboard = {
  candidates: [
    {
      id: "candidate-1",
      title: "Research paper",
      evidence: "Canvas lists a newer due date.",
    },
  ],
  conflicts: [
    {
      id: "conflict-1",
      kind: "source_change",
      description: "The assignment deadline changed.",
      candidateId: "candidate-1",
      entityType: "task",
      currentDueAt: "2026-09-10T17:00:00-07:00",
      proposedDueAt: "2026-09-12T17:00:00-07:00",
    },
  ],
} as unknown as Dashboard;

test("Canvas review identifies destinations and offers a linked Work to-do", async () => {
  const user = userEvent.setup();
  const onLinkedTaskSelection = vi.fn();
  const candidate = {
    id: "canvas-event",
    documentId: "canvas-calendar-source:connection",
    sourceConnectionId: "connection",
    kind: "commitment" as const,
    title: "Study group",
    course: "Canvas",
    startsAt: "2026-09-03T18:00:00Z",
    endsAt: "2026-09-03T19:00:00Z",
    evidence: "Canvas calendar event at 11 AM",
    sourceLocator: "Canvas calendar · event",
    sourceType: "canvas_calendar",
    confidence: 1,
    warnings: [],
    status: "pending" as const,
  };
  const { container } = render(
    <ReviewDialog
      candidates={[candidate]}
      selectedIds={[candidate.id]}
      linkedTaskCandidateIds={[]}
      canvasScoped
      conflictedIds={new Set()}
      busy={false}
      terms={[]}
      hasSourceChanges={false}
      close={vi.fn()}
      openConflicts={vi.fn()}
      onSelection={vi.fn()}
      onLinkedTaskSelection={onLinkedTaskSelection}
      onDashboard={vi.fn()}
      onError={vi.fn()}
      decide={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Review Canvas imports" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Canvas source")).toBeInTheDocument();
  expect(screen.getByText("Destination: Calendar")).toBeInTheDocument();
  await user.click(
    screen.getByRole("checkbox", {
      name: "Also add a linked to-do in Work",
    }),
  );
  expect(onLinkedTaskSelection).toHaveBeenCalledWith([candidate.id]);
  expect(
    (
      await axe.run(container, {
        rules: { "color-contrast": { enabled: false } },
      })
    ).violations,
  ).toEqual([]);
});

test("planning dialogs preserve review choices and replan reasons", async () => {
  const user = userEvent.setup();
  const resolveConflict = vi.fn();
  const submitReplan = vi.fn();
  const setReason = vi.fn();
  const { rerender } = render(
    <PlanningDialogs
      active="conflicts"
      dashboard={dashboard}
      busy={false}
      replanReason="I woke up late"
      close={vi.fn()}
      openReplan={vi.fn()}
      setReplanReason={setReason}
      resolveConflict={resolveConflict}
      submitReplan={submitReplan}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Use Canvas value" }));
  expect(resolveConflict).toHaveBeenCalledWith(
    "conflict-1",
    "use_source",
    "Canvas value accepted and plan rebuilt.",
  );

  rerender(
    <PlanningDialogs
      active="replan"
      dashboard={dashboard}
      busy={false}
      replanReason="I woke up late"
      close={vi.fn()}
      openReplan={vi.fn()}
      setReplanReason={setReason}
      resolveConflict={resolveConflict}
      submitReplan={submitReplan}
    />,
  );
  await user.click(screen.getByRole("button", { name: "I have less energy" }));
  await user.click(screen.getByRole("button", { name: "Build a realistic plan" }));
  expect(setReason).toHaveBeenCalledWith("I have less energy");
  expect(submitReplan).toHaveBeenCalledOnce();
});

test("assistant disclosure keeps submission behind provider and consent", async () => {
  const user = userEvent.setup();
  const submit = vi.fn();
  const { container } = render(
    <AssistantDialog
      providers={[{
        provider: "openai",
        connected: true,
        healthy: true,
        model: "test-model",
        capabilities: ["brain_dump"],
        disclosureUrl: "https://example.invalid/disclosure",
      }]}
      busy={false}
      capability="brain_dump"
      excerpt="Only this excerpt"
      consent={true}
      explanation=""
      close={vi.fn()}
      openSettings={vi.fn()}
      setCapability={vi.fn()}
      setExcerpt={vi.fn()}
      setConsent={vi.fn()}
      submit={submit}
    />,
  );
  expect(screen.getByText("openai · test-model")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Create reviewable result" }));
  expect(submit).toHaveBeenCalledOnce();
  expect((await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
});

test("profile deletion still requires the exact confirmation", async () => {
  const user = userEvent.setup();
  const erase = vi.fn();
  function Harness() {
    const [confirmation, setConfirmation] = useState("");
    return (
      <DeleteProfileDialog
        busy={false}
        confirmation={confirmation}
        close={vi.fn()}
        setConfirmation={setConfirmation}
        erase={erase}
      />
    );
  }
  render(<Harness />);
  const button = screen.getByRole("button", {
    name: "Permanently delete local profile",
  });
  expect(button).toBeDisabled();
  await user.type(screen.getByLabelText("Type DELETE MY PROFILE"), "DELETE MY PROFILE");
  expect(button).toBeEnabled();
  await user.click(button);
  expect(erase).toHaveBeenCalledOnce();
});

test("source retention and registrar changes stay explicit", async () => {
  const user = userEvent.setup();
  const choose = vi.fn();
  const apply = vi.fn();
  const setDeclined = vi.fn();
  const { rerender } = render(
    <RetentionDialog count={2} busy={false} close={vi.fn()} choose={choose} />,
  );
  expect(screen.getByText(/Source 1 of 2/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Delete source now" }));
  expect(choose).toHaveBeenCalledWith("delete_now");

  rerender(
    <CalendarRefreshDialog
      diff={{
        sourceLabel: "Registrar",
        changedTerms: [{
          termId: "term-1",
          termName: "Fall",
          field: "ends_on",
          current: "2026-12-10",
          proposed: "2026-12-12",
          evidence: "Registrar calendar",
        }],
        addedNoClassDates: [],
      }}
      declinedChanges={[]}
      busy={false}
      close={vi.fn()}
      setDeclinedChanges={setDeclined}
      apply={apply}
    />,
  );
  await user.click(screen.getByRole("checkbox"));
  expect(setDeclined).toHaveBeenCalledWith(["Fall:ends_on"]);
  await user.click(screen.getByRole("button", { name: "Apply selected" }));
  expect(apply).toHaveBeenCalledOnce();
});

test("schedule import keeps every entry path reachable", async () => {
  const user = userEvent.setup();
  const openCanvas = vi.fn();
  const selectFile = vi.fn();
  const enterManually = vi.fn();
  render(
    <ImportDialog
      busy={false}
      pasteTarget={createRef<HTMLButtonElement>()}
      documents={[]}
      documentSearch=""
      evidence={null}
      close={vi.fn()}
      openCanvas={openCanvas}
      capture={vi.fn()}
      photosImported={vi.fn()}
      selectFile={selectFile}
      enterManually={enterManually}
      setDocumentSearch={vi.fn()}
      openEvidence={vi.fn()}
      closeEvidence={vi.fn()}
      rereadWithAi={vi.fn()}
      onError={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /Canvas calendar link/ }));
  await user.click(screen.getByRole("button", { name: /Paste, choose, or drop a schedule/ }));
  await user.click(screen.getByRole("button", { name: /Enter classes manually/ }));
  expect(openCanvas).toHaveBeenCalledOnce();
  expect(selectFile).toHaveBeenCalledOnce();
  expect(enterManually).toHaveBeenCalledOnce();
  expect(screen.getByText("No encrypted documents match this search.")).toBeInTheDocument();
});
