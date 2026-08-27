import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bundleDirectory, verifyBundleSignature, verifyDiskImage } from "../verify-macos-signature.mjs";

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
    bundleDirectory({ target: "aarch64-apple-darwin" }),
    "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle",
  );
});

// The gate reads the .app back out of the disk image because the bundler
// deletes the staged copy once the DMG exists. That indirection is where the
// first version of this gate broke, so it is exercised against a real DMG.
function diskImage({ signApp }) {
  const { root, app } = unsealedBundle();
  if (signApp) {
    const signed = spawnSync("codesign", ["--force", "--sign", "-", app], { encoding: "utf8" });
    assert.equal(signed.status, 0, signed.stderr);
  }
  const dmg = join(root, "student-center-test.dmg");
  const created = spawnSync(
    "hdiutil",
    ["create", "-quiet", "-srcfolder", join(root, "Coqui Student Center.app"), "-volname", "Coqui Student Center", dmg],
    { encoding: "utf8" },
  );
  assert.equal(created.status, 0, created.stderr || created.stdout || `hdiutil exited ${created.status}`);
  return { root, dmg };
}

test("a DMG carrying a signed bundle passes the gate", { skip: process.platform !== "darwin" }, () => {
  const { root, dmg } = diskImage({ signApp: true });
  try {
    const result = verifyDiskImage({ dmgPath: dmg });
    assert.equal(result.signed, true, JSON.stringify(result.checks ?? result.error, null, 2));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a DMG carrying an unsealed bundle fails the gate", { skip: process.platform !== "darwin" }, () => {
  const { root, dmg } = diskImage({ signApp: false });
  try {
    const result = verifyDiskImage({ dmgPath: dmg });
    assert.equal(result.signed, false);
    assert.equal(result.checks.find((check) => check.name === "sealed resource directory").passed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing DMG fails rather than reporting success", { skip: process.platform !== "darwin" }, () => {
  const result = verifyDiskImage({ dmgPath: join(tmpdir(), "no-such-student-center.dmg") });
  assert.equal(result.signed, false);
  assert.match(result.error, /was not found/);
});
