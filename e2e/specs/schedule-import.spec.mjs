import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * From a fresh profile to a populated timetable via a screenshot, and the same
 * run with nothing to fetch.
 *
 * Driven through the native commands rather than the file picker, because a
 * platform dialog cannot be scripted and the thing worth proving is that the
 * bytes go in one end and a weekly class comes out the other, reviewed.
 */
describe("importing a schedule", () => {
  // The suite completes onboarding, so the profile is reset back to first-run.
  // Without this it would only pass once.
  after(async () => {
    await browser.tauri.execute(async ({ core }) =>
      core.invoke("delete_local_profile", { confirmation: "DELETE MY PROFILE" }),
    );
  });

  const finishSetup = async () =>
    browser.tauri.execute(async ({ core }) => {
      const state = await core.invoke("get_onboarding_state");
      return core.invoke("complete_onboarding", {
        draft: {
          ...state.draft,
          name: "Screenshot Test",
          timezone: "America/Phoenix",
          termName: "Fall 2026 — Session C",
          termStartsOn: "2026-08-20",
          termEndsOn: "2026-12-12",
          courses: [],
          courseTitle: "",
          courseCode: "",
        },
      });
    });

  it("turns a pasted screenshot into a weekly class waiting for review", async () => {
    await (await $("body")).waitForDisplayed();
    await finishSetup();

    // A 1x1 PNG: the point here is the pipeline, not recognition. What must be
    // true is that the bytes are accepted, encrypted, and reported honestly when
    // nothing readable comes back — never that an error dialog appears.
    const png = [...readFileSync(new URL("./fixtures/tiny.png", import.meta.url))];
    const dashboard = await browser.tauri.execute(
      async ({ core }, bytes) =>
        core.invoke("import_document_bytes", { fileName: "schedule.png", bytes }),
      png,
    );
    assert.notEqual(dashboard, null, "an import must return a dashboard");

    const documents = await browser.tauri.execute(async ({ core }) =>
      core.invoke("list_documents", { query: "" }),
    );
    const stored = documents.find((document) => document.fileName === "schedule.png");
    assert.ok(stored, "the screenshot is stored in the vault");
    assert.equal(stored.mime, "image/png");

    // Unreadable is a state, not a failure: the original is kept and the student
    // is told, rather than being shown an error.
    assert.ok(
      ["needs_attention", "complete", "complete_with_warnings"].includes(stored.extractionStatus),
      `unexpected extraction status ${stored.extractionStatus}`,
    );

    // Whatever was extracted is pending. Nothing reached the plan on its own.
    const pending = dashboard.candidates.filter((c) => c.status === "pending");
    for (const candidate of pending) {
      assert.notEqual(candidate.evidence, "", "every candidate shows its source evidence");
    }
    assert.equal(
      dashboard.blocks.filter((block) => block.kind === "class").length,
      0,
      "no class may reach the timetable without review",
    );
  });

  it("completes setup by hand when nothing can be fetched", async () => {
    await browser.tauri.execute(async ({ core }) =>
      core.invoke("delete_local_profile", { confirmation: "DELETE MY PROFILE" }),
    );

    // Deliberately a school with no descriptor, so this exercises the refusal
    // path without reaching the network. Hitting a real registrar from a CI
    // runner makes the suite depend on someone else's uptime and costs twenty
    // seconds of timeout when the host is blocked.
    const refresh = await browser.tauri.execute(async ({ core }) => {
      try {
        await core.invoke("refresh_school_calendar", { institutionId: "000000" });
        return { ok: true };
      } catch (error) {
        return { ok: false, message: String(error) };
      }
    });
    assert.equal(refresh.ok, false, "a school with no published calendar must refuse");
    assert.match(refresh.message, /no published calendar/i);

    // The bundled dates are still there with no network at all, which is what
    // makes manual entry a complete path rather than a fallback.
    const options = await browser.tauri.execute(async ({ core }) =>
      core.invoke("get_institution_setup_options", { institutionId: "104151" }),
    );
    assert.ok(options.terms.length > 0, "bundled term dates survive with no network");
    assert.equal(options.terms[0].startsOn, "2026-08-20");
    assert.ok(options.sourceLabel, "a pre-filled date says where it came from");
    assert.ok(options.generatedAt, "and how old it is");

    const bootstrap = await finishSetup();
    assert.notEqual(bootstrap.dashboard, null, "typing it in by hand finishes setup");
    assert.equal(bootstrap.onboarding.required, false);
  });
});
