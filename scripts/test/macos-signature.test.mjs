import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bundlePath, verifyBundleSignature } from "../verify-macos-signature.mjs";

// Reproduces the 0.9.0 defect: every Mach-O inside is linker-signed, so the app
// looks signed, but the bundle itself was never passed to codesign and carries
// no Contents/_CodeSignature. macOS calls that "damaged", not "unsigned".
function unsealedBundle() {
  const root = mkdtempSync(join(tmpdir(), "student-center-signature-"));
  const app = join(root, "Coqui Student Center.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>student-center</string>
  <key>CFBundleIdentifier</key><string>app.studentcenter.desktop.test</string>
  <key>CFBundleName</key><string>Coqui Student Center</string>
  <key>CFBundleVersion</key><string>0.0.0</string>
</dict></plist>
`,
    "utf8",
  );
  copyFileSync("/bin/echo", join(app, "Contents", "MacOS", "student-center"));
  return { root, app };
}

test("a bundle with no sealed resource directory fails the gate", () => {
  const { root, app } = unsealedBundle();
  try {
    const result = verifyBundleSignature({ appPath: app });
    assert.equal(result.signed, false);
    const seal = result.checks.find((check) => check.name === "sealed resource directory");
    assert.equal(seal.passed, false);
    assert.match(seal.detail, /never codesigned/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing bundle fails rather than reporting success", () => {
  const result = verifyBundleSignature({ appPath: join(tmpdir(), "no-such-student-center.app") });
  assert.equal(result.signed, false);
  assert.match(result.error, /was not found/);
});

test("an ad-hoc signed bundle passes the gate", { skip: process.platform !== "darwin" }, () => {
  const { root, app } = unsealedBundle();
  try {
    // Exactly what `signingIdentity: "-"` makes the Tauri bundler do.
    const signed = spawnSync("codesign", ["--force", "--sign", "-", app], { encoding: "utf8" });
    assert.equal(signed.status, 0, signed.stderr);
    const result = verifyBundleSignature({ appPath: app });
    assert.equal(result.signed, true, JSON.stringify(result.checks, null, 2));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the release target maps to the path the workflow packages from", () => {
  assert.equal(
    bundlePath({ target: "aarch64-apple-darwin" }),
    "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Coqui Student Center.app",
  );
});
