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
    assert.equal(bootstrap.schemaVersion, 13);
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
});
