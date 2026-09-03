import assert from "node:assert/strict";

describe("installed Student Center", () => {
  // The second test completes onboarding, so the test profile is reset back to a
  // first-run state. Without this the suite would only pass once.
  after(async () => {
    await browser.tauri.execute(async ({ core }) =>
      core.invoke("delete_local_profile", { confirmation: "DELETE MY PROFILE" }),
    );
  });

  it("launches the bundled UI and exposes an empty native first run", async () => {
    const body = await $("body");
    await body.waitForDisplayed();
    await browser.waitUntil(async () => (await body.getText()).includes("Make it yours"));
    const bootstrap = await browser.tauri.execute(async ({ core }) => core.invoke("app_initialize"));
    assert.equal(bootstrap.schemaVersion, 26);
    assert.equal(bootstrap.onboarding.required, true);
    assert.equal(bootstrap.dashboard, null);
    assert.doesNotMatch(await body.getText(), /Alex Morgan/);
  });

  it("finishes setup from a name and timezone alone and returns a usable plan", async () => {
    // Mirrors a student who skips school, courses, and rhythm. The bootstrap
    // must come back with a dashboard; a null one strands the loading screen.
    const bootstrap = await browser.tauri.execute(async ({ core }) => {
      const state = await core.invoke("get_onboarding_state");
      const draft = {
        ...state.draft,
        name: "Skip Test",
        timezone: "America/Phoenix",
        courses: [],
        courseTitle: "",
        courseCode: "",
      };
      return core.invoke("complete_onboarding", { draft });
    });
    assert.equal(bootstrap.onboarding.required, false);
    assert.notEqual(bootstrap.dashboard, null, "a completed setup must return a dashboard");
    assert.equal(bootstrap.dashboard.studentName, "Skip Test");

    const workspace = await browser.tauri.execute(async ({ core }) => core.invoke("get_local_workspace"));
    assert.equal(workspace.courses.length, 0, "skipping courses must not invent one");
  });

  it("navigates every desktop workspace and opens Settings detail pages", async () => {
    await browser.refresh();
    const destinations = [
      ["Today", null],
      ["Calendar", "Calendar"],
      ["Work", "Work"],
      ["Courses", "Courses"],
      ["Study", "Study"],
      ["Scholarships", "Scholarships"],
      ["Settings", "Settings"],
    ];
    for (const [label, heading] of destinations) {
      const button = await $(`button[aria-label="${label}"]`);
      await button.click();
      await browser.waitUntil(async () => (await button.getAttribute("class")).includes("active"));
      if (heading) {
        await browser.waitUntil(async () => (await $("h1").getText()) === heading);
      }
    }

    const canvas = await $('button*=Canvas');
    await canvas.click();
    const detail = await $('section[aria-labelledby="settings-detail-title"]');
    await detail.waitForDisplayed();
    assert.equal(await detail.$('h1').getText(), "Connect Canvas");
    await browser.keys(["Escape"]);
    await detail.waitForDisplayed({ reverse: true });
  });

  it("persists appearance and Scholarship Center records through native storage", async () => {
    const result = await browser.tauri.execute(async ({ core }) => {
      await core.invoke("update_appearance", { appearance: "light" });
      await core.invoke("update_accent", { accent: "green" });
      const now = new Date().toISOString();
      const opportunity = {
        id: "e2e-scholarship",
        sourceId: "manual",
        canonicalUrl: "https://example.edu/scholarships/e2e",
        provider: "E2E University",
        title: "Installed-app scholarship",
        deadline: "2026-12-01",
        datePrecision: "date",
        applicationUrl: "https://example.edu/scholarships/e2e",
        studyLevels: [],
        fieldsOfStudy: [],
        locations: [],
        citizenship: [],
        residency: [],
        essayPrompts: [{ id: "essay", prompt: "Describe your goals", wordLimit: 500 }],
        requiredDocuments: [],
        fetchedAt: now,
        freshness: "unknown",
        verificationStatus: "unverified",
        aiPolicy: "unknown",
        notes: "",
        priority: "medium",
        state: "saved",
        taskIds: [],
      };
      await core.invoke("save_scholarship_opportunity", { opportunity });
      await core.invoke("save_scholarship_draft", {
        draft: {
          id: "e2e-draft",
          opportunityId: opportunity.id,
          promptId: "essay",
          title: "Installed-app draft",
          outline: "Opening; evidence; close",
          content: "A student-authored draft persisted by the installed application.",
          wordLimit: 500,
          updatedAt: now,
          versions: [],
        },
      });
      await core.invoke("plan_scholarship_deadline", {
        opportunityId: opportunity.id,
      });
      return {
        workspace: await core.invoke("get_local_workspace"),
        scholarships: await core.invoke("get_scholarship_workspace"),
      };
    });
    assert.equal(result.workspace.appearance, "light");
    const opportunity = result.scholarships.opportunities.find(
      (item) => item.id === "e2e-scholarship",
    );
    assert.ok(opportunity, "the saved scholarship must reopen");
    assert.equal(opportunity.taskIds.length, 1, "deadline planning must be idempotently linked");
    const draft = result.scholarships.drafts.find((item) => item.id === "e2e-draft");
    assert.equal(draft.versions.length, 1, "an explicit draft version must persist");
  });
});
