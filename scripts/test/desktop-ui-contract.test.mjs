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
const routeSources = Object.fromEntries(
  await Promise.all(
    ["CalendarView", "WorkView", "CoursesView", "AcademicSettingsView"].map(
      async (name) => [
        name,
        await readFile(
          new URL(
            `../../apps/desktop-ui/src/components/${name}.tsx`,
            import.meta.url,
          ),
          "utf8",
        ),
      ],
    ),
  ),
);
const workspaceView = Object.values(routeSources).join("\n");
const taskInspector = await readFile(new URL("../../apps/desktop-ui/src/features/tasks/TaskInspector.tsx", import.meta.url), "utf8");
const calendarInspector = await readFile(new URL("../../apps/desktop-ui/src/features/calendar/CalendarInspector.tsx", import.meta.url), "utf8");
const today = await readFile(
  new URL(
    "../../apps/desktop-ui/src/components/TodayView.tsx",
    import.meta.url,
  ),
  "utf8",
);
const scholarships = await readFile(
  new URL(
    "../../apps/desktop-ui/src/components/ScholarshipsView.tsx",
    import.meta.url,
  ),
  "utf8",
);
const quickAdd = await readFile(
  new URL(
    "../../apps/desktop-ui/src/components/QuickAddTaskModal.tsx",
    import.meta.url,
  ),
  "utf8",
);
const workspaceSearch = await readFile(
  new URL(
    "../../apps/desktop-ui/src/components/WorkspaceSearchModal.tsx",
    import.meta.url,
  ),
  "utf8",
);
const contracts = await readFile(
  new URL("../../packages/contracts/src/index.ts", import.meta.url),
  "utf8",
);
const shellSources = `${ui}\n${today}`;
const onboarding = await readFile(
  new URL(
    "../../apps/desktop-ui/src/components/OnboardingExperience.tsx",
    import.meta.url,
  ),
  "utf8",
);
const checklist = await readFile(
  new URL(
    "../../apps/desktop-ui/src/components/SetupChecklist.tsx",
    import.meta.url,
  ),
  "utf8",
);
const styles = await readFile(
  new URL("../../apps/desktop-ui/src/styles.css", import.meta.url),
  "utf8",
);
const experienceStyles = await readFile(
  new URL(
    "../../apps/desktop-ui/src/experience-overrides.css",
    import.meta.url,
  ),
  "utf8",
);
const logo = await readFile(
  new URL("../../apps/desktop-ui/public/coqui-mark.svg", import.meta.url),
  "utf8",
);
const institutionProviders = JSON.parse(
  await readFile(
    new URL(
      "../../apps/desktop/src-tauri/resources/institution-setup-providers.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const mainRs = await readFile(
  new URL("../../apps/desktop/src-tauri/src/main.rs", import.meta.url),
  "utf8",
);
const firstRunSpec = await readFile(
  new URL("../../e2e/specs/first-run.spec.mjs", import.meta.url),
  "utf8",
);

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
  assert.doesNotMatch(
    onboarding,
    /Alex Morgan|demoReviewRequired|demoCandidates/,
  );
  // Derived from the Rust constant rather than written out here. Pinning the
  // number in this file is what let the browser fixtures and the e2e assertion
  // sit on 11 for a whole release after the schema moved to 12.
  const schemaVersion = Number(
    /const CURRENT_SCHEMA_VERSION: i64 = (\d+);/.exec(mainRs)?.[1],
  );
  assert.ok(
    schemaVersion > 0,
    "CURRENT_SCHEMA_VERSION must be readable from main.rs",
  );
  assert.match(native, new RegExp(`schemaVersion: ${schemaVersion},`));
  assert.doesNotMatch(
    native,
    new RegExp(`schemaVersion: (?!${schemaVersion},)\\d+,`),
    "every browser fixture must report the current schema version",
  );
  assert.match(
    firstRunSpec,
    new RegExp(
      `assert\\.equal\\(bootstrap\\.schemaVersion, ${schemaVersion}\\);`,
    ),
    "the e2e first-run spec asserts the schema version and drifts silently otherwise",
  );
});

test("onboarding offers the same four review-first schedule sources as Calendar", () => {
  for (const copy of [
    "Connect a Canvas calendar link",
    "Capture screen area",
    "Import a file or document",
    "Your courses",
  ]) {
    assert.match(onboarding, new RegExp(copy));
  }
  assert.match(
    onboarding,
    /const submittedUrl = canvasFeedUrl\.trim\(\)[\s\S]{0,500}connectCanvasCalendar\(submittedUrl\)/,
  );
  assert.match(onboarding, /launchScheduleCapture\(\)/);
  assert.match(onboarding, /selectAndImport\(\)/);
  // A source imported during setup is already in the review queue. It must not
  // turn on the separate “choose a syllabus after setup” picker.
  assert.doesNotMatch(onboarding, /setImportAfter\(true\)/);
  assert.match(
    ui,
    /result\.dashboard\.candidates\.some[\s\S]{0,200}setModal\("review"\)/,
  );
});

// A student can attend several ASU campuses at once, so the campus step is a
// set rather than a single choice. The first pick stays primary because it fills
// the location on new class meetings, and "Online or multiple campuses" is a
// statement that no single campus applies, so it never combines with one.
test("campus selection is multi-select with a primary and an exclusive flexible option", () => {
  assert.match(onboarding, /campusIds/);
  assert.match(onboarding, /const toggleCampus =/);
  assert.match(onboarding, /aria-pressed=\{position >= 0\}/);
  assert.match(onboarding, /Primary/);
  // Deselecting must be reachable, otherwise a mis-tap is unrecoverable.
  assert.match(onboarding, /selected\.filter\(\(id\) => id !== campus\.id\)/);
  // Picking the flexible option replaces the set instead of joining it.
  assert.match(onboarding, /if \(isFlexible\) next = \[campus\.id\]/);
  assert.doesNotMatch(onboarding, /<legend>Primary campus<\/legend>/);
});

// Each destination owns its state, loading, and markup. The behavioural
// assertion lives in workspace-tabs.test.tsx; this guard keeps a future pass
// from folding them back into one mode-switched component.
test("calendar, work, courses, and academic settings are feature-owned routes", () => {
  assert.match(routeSources.CalendarView, /export function CalendarView/);
  assert.match(routeSources.WorkView, /export function WorkView/);
  assert.match(routeSources.CoursesView, /export function CoursesView/);
  assert.match(
    routeSources.AcademicSettingsView,
    /export function AcademicSettingsView/,
  );
  for (const source of Object.values(routeSources))
    // Interface mode (Comfy/Compact) is shared presentation, not route multiplexing.
    assert.doesNotMatch(source, /WorkspaceView|route\.mode|mode === ["'](?:calendar|work|courses|academics|assignments)/);
  assert.match(routeSources.WorkView, /<TaskInspector/);
  assert.match(routeSources.CalendarView, /<CalendarInspector/);
  assert.doesNotMatch(
    styles,
    /\.workspace-grid\.\w+\s*>\s*\.workspace-panel:(first-child|nth-child)/,
  );
  assert.doesNotMatch(
    styles,
    /\.mode-(courses|assignments) \.\w+-editor\s*\{?[^}]*display:\s*none/,
  );
});

test("calendar, work, and courses expose complete local controls", () => {
  const interfaceSource = `${workspaceView}\n${taskInspector}\n${calendarInspector}\n${ui}\n${quickAdd}\n${workspaceSearch}`;
  for (const control of [
    "Week calendar",
    "time grid from 6 AM to 10 PM",
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
    assert.match(interfaceSource, new RegExp(control));
  }
  // Quick Add silently dropped the due date, leaving the planner nothing to
  // schedule against.
  assert.match(
    quickAdd,
    /addTask\(\s*title\.trim\(\),\s*minutes,\s*due \? new Date\(due\)\.toISOString\(\) : undefined,\s*courseId \|\| undefined,/,
  );
  // These wrappers all existed in native.ts already; what was missing was any
  // caller, so assert the interface actually invokes them.
  for (const caller of [
    "createCommitment(",
    "updateCommitment(",
    "deleteCommitment(",
    "movePlanBlock(",
    "setPlanBlockLock(",
    "undoCalendarChange",
    "createLocalTask(",
    "updateLocalTask(",
    "deleteLocalTask(",
    "createCourse(",
    "updateCourse(",
    "deleteCourse(",
    "createInstructor(",
    "createAcademicTerm(",
    "updateAcademicTerm(",
    "deleteAcademicTerm(",
    "updateInstructor(",
    "deleteInstructor(",
    "createClassMeeting(",
    "updateClassMeeting(",
    "deleteClassMeeting(",
    "createAcademicEvent(",
    "updateAcademicEvent(",
    "deleteAcademicEvent(",
    "updatePlanningPreferences(",
    "updateStudentProfile(",
  ]) {
    assert.ok(
      `${workspaceView}\n${taskInspector}\n${calendarInspector}`.includes(caller),
      `${caller} has no caller in the interface`,
    );
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
  assert.match(
    ui,
    /const submittedKey\s*=\s*aiKey;\s*setAiKey\(""\);[\s\S]{0,300}saveAiProviderKey\(\s*aiProvider,\s*submittedKey/,
  );
  assert.match(
    ui,
    /const submittedUrl\s*=\s*canvasUrl\.trim\(\);[\s\S]{0,300}setCanvasUrl\(""\);[\s\S]{0,1400}connectCanvasCalendar\(\s*submittedUrl/,
  );
});

test("Coqui branding, themes, and source-labeled predictions are bundled", () => {
  assert.match(logo, /#145B43/i);
  assert.match(logo, /<path/);
  assert.match(onboarding, /ThemeControls/);
  assert.match(onboarding, /sourceLabel/);
  assert.match(onboarding, /searchInstitutions/);
});

test("navigation reflows at the locked mobile and icon-rail breakpoints", () => {
  assert.match(styles, /@media \(max-width: 767px\)/);
  assert.match(
    experienceStyles,
    /@media \(min-width: 768px\) and \(max-width: 1199px\)[\s\S]{0,180}grid-template-columns: 78px minmax\(0, 1fr\)/,
  );
  assert.match(
    experienceStyles,
    /@media \(max-width: 400px\)[\s\S]{0,220}\.top-actions \.icon-btn:last-child \{ display: none; \}[\s\S]{0,220}\.fab span \{ display: none; \}/,
  );
  assert.match(
    experienceStyles,
    /\.scholarship-tabs button\{flex:1;min-width:0;/,
  );
});

test("school setup uses sourced ASU campuses and registrar dates", () => {
  const asu = institutionProviders.find(
    (provider) => provider.institutionId === "104151",
  );
  assert.ok(asu);
  assert.deepEqual(
    asu.campuses.slice(0, 4).map((campus) => campus.name),
    ["Tempe", "Downtown Phoenix", "West Valley", "Polytechnic"],
  );
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
    // Two sessions of one term end on different days, so the registrar's own
    // session letter is what tells "Fall 2026 — Session C" from Session A.
    sessionCode: "C",
    // Harvested from the live registrar page, not invented to fill the field.
    noClassDates: [
      {
        startsOn: "2026-10-10",
        endsOn: "2026-10-13",
        label: "Fall break Classes excused/University open",
      },
      {
        startsOn: "2026-11-26",
        endsOn: "2026-11-27",
        label:
          "Thanksgiving holiday observed Classes excused/University closed",
      },
    ],
  });
  assert.match(onboarding, /No verified calendar connected yet/);
  assert.match(onboarding, /Coqui will not guess them/);
  assert.doesNotMatch(onboarding, />Fall semester</);
});

// The descriptor is the whole reason no school gets a code branch: where the
// calendar lives, whether a catalog is readable, and what a weekday header looks
// like are all data. A descriptor that stopped carrying them would push that
// knowledge back into Rust without anything failing.
test("the school descriptor states its sources as data rather than in code", () => {
  const asu = institutionProviders.find(
    (provider) => provider.institutionId === "104151",
  );
  assert.equal(asu.schemaVersion, 1);
  assert.equal(
    asu.calendarSource.url,
    "https://registrar.asu.edu/academic-calendar",
  );
  // The registrar page lists a label and then a date per session, each on its
  // own line. It is not a table and not one row of text per event.
  assert.equal(asu.calendarSource.kind, "html-sessions");
  // How to read it is data too. Without these the app knows the address of a
  // page it cannot make any sense of.
  assert.ok(asu.calendarSource.datePattern.includes("(?P<start>"));
  assert.ok(asu.calendarSource.datePattern.includes("(?P<year>"));
  assert.ok(asu.calendarSource.sessionPattern.includes("(?P<session>"));
  assert.ok(asu.calendarSource.dateFormat);

  // ASU's class search answers 401 anonymously and authenticates through
  // weblogin. "none" is the honest answer and has to stay a supported state.
  assert.equal(asu.catalogSource.kind, "none");
  assert.match(asu.catalogSource.note, /weblogin|access control/i);

  const layouts = asu.scheduleLayouts;
  assert.ok(
    layouts.length > 0,
    "the screenshot reader learns layouts from here",
  );
  for (const layout of layouts) {
    assert.ok(["grid", "list"].includes(layout.shape));
    const weekdays = layout.weekdayTokens.map((entry) => entry.weekday);
    assert.deepEqual(
      weekdays,
      [0, 1, 2, 3, 4, 5, 6],
      "0 = Sunday, one entry each",
    );
    // "Th" has to win over "T" or Thursday parses as Tuesday plus a stray h.
    const thursday = layout.weekdayTokens.find((entry) => entry.weekday === 4);
    assert.ok(thursday.tokens.includes("th"));
    for (const entry of layout.weekdayTokens) {
      for (const token of entry.tokens) {
        assert.equal(
          token,
          token.toLowerCase(),
          "the reader lowercases before matching",
        );
      }
    }
  }
});

test("browser test mode mocks local mutations without becoming a product site", () => {
  assert.match(native, /if \(!isDesktop\(\)\)/);
  assert.match(native, /structuredClone\(browserWorkspace\)/);
  assert.match(shellSources, /Synthetic browser preview/);
  assert.doesNotMatch(
    native,
    /serviceWorker|beforeinstallprompt|manifest\.webmanifest/,
  );
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
  assert.match(
    ui,
    /if \(result\.dashboard\) \{[\s\S]{0,500}setData\(result\.dashboard\);[\s\S]{0,500}\}\s*else retryBoot\(\);/,
  );
  assert.ok(ui.includes('role="alert"'));
});

test("startup work is deferred off the main thread", () => {
  // OCR readiness now arrives as an event, so the card needs a third state.
  assert.ok(native.includes("listenForOcrStatus"));
  assert.ok(native.includes("studentcenter:ocr-status"));
  assert.match(
    native,
    /export type OcrPhase = "checking" \| "ready" \| "unavailable";/,
  );
  // Diagnostics moved into the expandable workspace status instead of a
  // permanently visible OCR card. The event and live message remain connected.
  assert.ok(shellSources.includes("Workspace status"));
  assert.ok(shellSources.includes("p.ocr.message"));
  assert.ok(ui.includes("ocrStatus ?? data.ocr"));
});

test("vault and BYOK AI remain review-first and explicitly consented", () => {
  for (const copy of [
    "Paste, choose, or drop a schedule",
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
    "request_ai_capability",
    "onDragDropEvent",
  ]) {
    assert.match(native, new RegExp(command));
  }
});

test("scholarship requirement sources are encrypted and review-first", () => {
  assert.match(contracts, /ScholarshipRequirementDocument/);
  for (const wrapper of [
    "importScholarshipRequirements",
    "applyScholarshipRequirementsReview",
  ]) {
    assert.match(native, new RegExp(wrapper));
    assert.match(scholarships, new RegExp(wrapper));
  }
  for (const command of [
    "import_scholarship_requirements",
    "apply_scholarship_requirements_review",
  ]) {
    assert.match(native, new RegExp(command));
    assert.match(mainRs, new RegExp(command));
  }
  assert.match(mainRs, /scholarship_requirement_documents/);
  assert.match(scholarships, /Requirement sources/);
  assert.match(scholarships, /Apply selected details/);
  assert.doesNotMatch(scholarships, /onImport/);
});
