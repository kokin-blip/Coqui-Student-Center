import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CURRENT_PROVIDER_SCHEMA_VERSION,
  SchoolProviderBundle,
  hasReadableCatalog,
} from "../src/school-provider.js";

/**
 * The cross-language pin. This schema and
 * `apps/desktop/src-tauri/src/school_provider.rs` are hand-written mirrors with
 * no codegen between them, so the thing that keeps them honest is that both
 * parse the same bundled bytes in their own suites. Rename a field on one side
 * and the other's parse fails here or in `the_bundled_descriptor_round_trips`.
 */
const bundledPath = new URL(
  "../../../apps/desktop/src-tauri/resources/institution-setup-providers.json",
  import.meta.url,
);
const raw = await readFile(bundledPath, "utf8");

test("the bundled descriptor parses against the mirrored schema", () => {
  const parsed = SchoolProviderBundle.parse(JSON.parse(raw));
  assert.ok(parsed.length > 0, "the bundle ships at least one school");

  for (const provider of parsed) {
    assert.equal(
      provider.schemaVersion,
      CURRENT_PROVIDER_SCHEMA_VERSION,
      "every bundled descriptor states its schema version",
    );
    for (const term of provider.terms) {
      assert.ok(term.startsOn && term.endsOn, "a term with no dates pre-fills nothing");
      // A term that claims a source but not a URL is unverifiable, and the
      // setup screen prints the label as if it were checkable.
      if (term.sourceLabel) assert.ok(term.sourceUrl, `${term.id} cites a source with no URL`);
    }
    for (const layout of provider.scheduleLayouts) {
      const weekdays = layout.weekdayTokens.map((entry) => entry.weekday);
      assert.equal(new Set(weekdays).size, weekdays.length, "one entry per weekday");
      if (layout.shape === "list") {
        assert.ok(layout.columns.length > 0, "a list layout needs a column order to be useful");
      }
    }
  }
});

test("re-serializing the bundle produces the same value", () => {
  const parsed = SchoolProviderBundle.parse(JSON.parse(raw));
  const reparsed = SchoolProviderBundle.parse(JSON.parse(JSON.stringify(parsed)));
  assert.deepEqual(parsed, reparsed, "descriptors must survive a round trip");
});

test("a mistyped key is rejected rather than dropped", () => {
  // The file and its parser ship together, so there is no forward-compatibility
  // reason to accept unknown keys — and a silently ignored typo is a school
  // whose calendar quietly never refreshes.
  const result = SchoolProviderBundle.safeParse([
    { institutionId: "1", schemaVersion: 1, campusez: [] },
  ]);
  assert.equal(result.success, false);
});

test("no readable catalog is a supported state, not a misconfiguration", () => {
  const parsed = SchoolProviderBundle.parse(JSON.parse(raw));
  const asu = parsed.find((provider) => provider.institutionId === "104151");
  assert.ok(asu, "ASU is the bundled example");
  // Its class search authenticates through weblogin, so the descriptor says so
  // plainly instead of pretending a catalog exists.
  assert.equal(hasReadableCatalog(asu), false);
  assert.ok(asu.catalogSource?.note, "the reason for having no catalog is worth stating");
});

test("weekday tokens are stored lowercased and cover a valid index", () => {
  const parsed = SchoolProviderBundle.parse(JSON.parse(raw));
  for (const provider of parsed) {
    for (const layout of provider.scheduleLayouts) {
      for (const entry of layout.weekdayTokens) {
        assert.ok(entry.weekday >= 0 && entry.weekday <= 6, "0 = Sunday through 6 = Saturday");
        for (const token of entry.tokens) {
          assert.equal(token, token.toLowerCase(), "the reader lowercases before matching");
        }
      }
    }
  }
});
