import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ui = await readFile(
  new URL("../../apps/desktop-ui/src/StudentCenter.tsx", import.meta.url),
  "utf8",
);
const native = await readFile(
  new URL("../../apps/desktop-ui/src/native.ts", import.meta.url),
  "utf8",
);
const onboarding = await readFile(
  new URL("../../apps/desktop-ui/src/components/OnboardingExperience.tsx", import.meta.url),
  "utf8",
);
const checklist = await readFile(
  new URL("../../apps/desktop-ui/src/components/SetupChecklist.tsx", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../../apps/desktop-ui/src/styles.css", import.meta.url),
  "utf8",
);
const logo = await readFile(
  new URL("../../apps/desktop-ui/public/coqui-mark.svg", import.meta.url),
  "utf8",
);
const institutionProviders = JSON.parse(await readFile(
  new URL("../../apps/desktop/src-tauri/resources/institution-setup-providers.json", import.meta.url),
  "utf8",
));

test("first-run UI is a four-stage local onboarding flow with no demo review", () => {
  for (const copy of [
    "Make it yours",
    "School and term",
    "Courses and class times",
    "Your weekly rhythm",
    "No sample student",
  ]) {
    assert.match(onboarding, new RegExp(copy));
  }
  assert.doesNotMatch(onboarding, /Alex Morgan|demoReviewRequired|demoCandidates/);
  assert.match(native, /schemaVersion: 11/);
});

// Assignments and Courses emit the same markup and are told apart purely by
// CSS. Drop either class binding and the two tabs silently become the same
// screen, which no other test would notice.
test("assignments and courses stay distinct screens", () => {
  assert.match(ui, /className=\{`content workspace-page mode-\$\{mode\}`\}/);
  assert.match(ui, /className=\{`workspace-grid academics \$\{mode\}`\}/);
  for (const rule of [
    /\.workspace-grid\.assignments\s*>\s*\.workspace-panel:first-child/,
    /\.workspace-grid\.courses\s*>\s*\.workspace-panel:nth-child\(2\)/,
    /\.mode-courses \.task-editor/,
    /\.mode-assignments \.preference-editor/,
  ]) {
    assert.match(styles, rule);
  }
});

test("timetable, assignments, and courses expose complete local controls", () => {
  for (const control of [
    "Seven-day visual calendar",
    "Seven-day agenda view",
    "Prerequisites",
    "Minimum session",
    "Maximum session",
    "Weekly availability",
    "Save profile and replan",
    "Lock",
    "Unlock",
    "Assignments & exams",
    "Add an instructor",
    "Add a recurring class time",
    "Academic calendar",
    // Every one of these had a working command and wrapper but no caller, so
    // the record was reachable only until the moment it was created.
    "Edit instructor",
    "Edit class time",
    "Academic terms",
    "Add a term",
    "Edit term",
    "Edit academic event",
    "Search your workspace",
  ]) {
    assert.match(ui, new RegExp(control));
  }
  // Quick Add silently dropped the due date, leaving the planner nothing to
  // schedule against.
  assert.match(ui, /addTask\(\s*taskTitle\.trim\(\),\s*taskMinutes,/);
  // These wrappers all existed in native.ts already; what was missing was any
  // caller, so assert the interface actually invokes them.
  for (const caller of [
    "createAcademicTerm(",
    "updateAcademicTerm(",
    "deleteAcademicTerm(",
    "updateInstructor(",
    "deleteInstructor(",
    "updateClassMeeting(",
    "deleteClassMeeting(",
    "updateAcademicEvent(",
    "deleteAcademicEvent(",
  ]) {
    assert.ok(ui.includes(caller), `${caller} has no caller in the interface`);
  }
  for (const command of [
    "get_calendar_agenda",
    "set_plan_block_lock",
    "update_student_profile",
    "create_local_task",
    "update_planning_preferences",
    "create_instructor",
    "create_class_meeting",
    "create_academic_event",
  ]) {
    assert.match(native, new RegExp(command));
  }
});

test("Coqui branding, themes, and source-labeled predictions are bundled", () => {
  assert.match(logo, /#0b746b/i);
  assert.match(logo, /<path/);
  assert.match(onboarding, /ThemeControls/);
  assert.match(onboarding, /sourceLabel/);
  assert.match(onboarding, /searchInstitutions/);
});

test("school setup uses sourced ASU campuses and registrar dates", () => {
  const asu = institutionProviders.find((provider) => provider.institutionId === "104151");
  assert.ok(asu);
  assert.deepEqual(asu.campuses.slice(0, 4).map((campus) => campus.name), [
    "Tempe",
    "Downtown Phoenix",
    "West Valley",
    "Polytechnic",
  ]);
  assert.deepEqual(asu.terms[0], {
    id: "asu-fall-2026-c",
    name: "Fall 2026 — Session C",
    startsOn: "2026-08-20",
    endsOn: "2026-12-12",
    classEndsOn: "2026-12-04",
    examStartsOn: "2026-12-07",
    details: "Classes Aug 20–Dec 4 · Finals Dec 7–12",
    sourceLabel: "ASU University Registrar",
    sourceUrl: "https://registrar.asu.edu/academic-calendar",
  });
  assert.match(onboarding, /No verified calendar connected yet/);
  assert.match(onboarding, /Coqui will not guess them/);
  assert.doesNotMatch(onboarding, />Fall semester</);
});

test("browser test mode mocks local mutations without becoming a product site", () => {
  assert.match(native, /if \(!isDesktop\(\)\)/);
  assert.match(native, /structuredClone\(browserWorkspace\)/);
  assert.match(ui, /UI test mode/);
  assert.doesNotMatch(native, /serviceWorker|beforeinstallprompt|manifest\.webmanifest/);
});

test("onboarding gates only the profile step and lets every other step be skipped", () => {
  // Steps 2-4 must be unconditionally passable.
  assert.match(
    onboarding,
    /const canContinue = \[\s*Boolean\(draft\.name\.trim\(\) && draft\.timezone && timezoneConfirmed\),\s*true,\s*true,\s*true,\s*\]\[step\];/,
  );
  assert.ok(onboarding.includes("Skip for now"));
  for (const copy of [
    "Optional. It keeps course suggestions relevant.",
    "Optional. Add classes now, or skip and add them later.",
    "Optional. Sensible defaults are already filled in.",
    "Don't have your schedule yet?",
    "No courses yet",
  ]) {
    assert.ok(onboarding.includes(copy), `missing onboarding copy: ${copy}`);
  }
  // The planner needs one availability window, so the last day stays locked.
  assert.ok(onboarding.includes("toggleAvailability"));
});

test("the Today checklist picks up the setup work onboarding no longer demands", () => {
  assert.ok(ui.includes("SetupChecklist"));
  assert.ok(ui.includes("isSetupChecklistDismissed"));
  for (const copy of [
    "Finish setting up",
    "Add your first class",
    "Add your class times",
    "Add an assignment or exam",
  ]) {
    assert.ok(checklist.includes(copy), `missing checklist copy: ${copy}`);
  }
  assert.ok(checklist.includes("coqui.setupChecklist.dismissed"));
});

test("loading screens surface an error and a retry instead of hanging", () => {
  // The original copy must survive; the error branches are additive.
  assert.ok(ui.includes("Opening your private workspace…"));
  assert.ok(ui.includes("Loading your plan…"));
  for (const copy of [
    "We could not open your workspace.",
    "We could not load your plan.",
    "Try again",
    "Reload plan",
  ]) {
    assert.ok(ui.includes(copy), `missing recovery copy: ${copy}`);
  }
  // A null dashboard after onboarding must re-fetch rather than strand the app.
  assert.match(ui, /if \(result\.dashboard\) setData\(result\.dashboard\);\s*\n\s*else retryBoot\(\);/);
  assert.ok(ui.includes('role="alert"'));
});

test("startup work is deferred off the main thread", () => {
  // OCR readiness now arrives as an event, so the card needs a third state.
  assert.ok(native.includes("listenForOcrStatus"));
  assert.ok(native.includes("studentcenter:ocr-status"));
  assert.match(native, /export type OcrPhase = "checking" \| "ready" \| "unavailable";/);
  assert.ok(ui.includes("Checking local OCR"));
});

test("vault and managed AI remain review-first and explicitly consented", () => {
  for (const copy of [
    "Choose or drop academic files",
    "Document library",
    "Saved source evidence",
    "I consent to sending only this excerpt",
    "Responses become reviewable candidates",
  ]) {
    assert.match(ui, new RegExp(copy));
  }
  for (const command of [
    "list_documents",
    "get_document_evidence",
    "request_managed_ai",
    "onDragDropEvent",
  ]) {
    assert.match(native, new RegExp(command));
  }
});
