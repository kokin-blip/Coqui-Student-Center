import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyRuntime } from "../verify-ocr-runtime.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

test("strict OCR verification accepts only a source-bound file lock", () => {
  const root = mkdtempSync(join(tmpdir(), "student-center-ocr-test-"));
  try {
    const target = "windows-x64";
    const targetRoot = join(root, target);
    mkdirSync(join(targetRoot, "bin"), { recursive: true });
    const sources = Buffer.from('{"runtimeVersion":"fixture-1"}\n');
    const runtime = Buffer.from("verified runtime");
    writeFileSync(join(root, "runtime-sources.json"), sources);
    writeFileSync(join(targetRoot, "bin", "fixture.exe"), runtime);
    writeFileSync(join(targetRoot, "runtime-lock.json"), JSON.stringify({
      target,
      runtimeVersion: "fixture-1",
      sourceManifestSha256: hash(sources),
      files: { "bin/fixture.exe": hash(runtime) },
    }));

    const verified = verifyRuntime({ root, target, strict: true });
    assert.equal(verified.ready, true);

    writeFileSync(join(targetRoot, "bin", "fixture.exe"), "tampered runtime");
    const tampered = verifyRuntime({ root, target, strict: true });
    assert.equal(tampered.ready, false);
    assert.equal(tampered.checks[0].verified, false);

    writeFileSync(join(targetRoot, "bin", "fixture.exe"), runtime);
    writeFileSync(join(root, "runtime-sources.json"), `${readFileSync(join(root, "runtime-sources.json"), "utf8")} `);
    const changedSources = verifyRuntime({ root, target, strict: true });
    assert.equal(changedSources.ready, false);
    assert.equal(changedSources.sourceManifestVerified, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
