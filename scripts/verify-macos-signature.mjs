import { spawnSync } from "node:child_process";
import { existsSync, openSync, readSync, closeSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A Tauri bundle whose executables are only linker-signed but whose .app carries
// no _CodeSignature seal is reported by Gatekeeper as "damaged and cannot be
// opened" — a state with no user-facing bypass. That shipped in 0.9.0, so the
// seal is verified here rather than assumed from the presence of a config key.
const MACH_O_MAGIC = new Set([0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca]);

function isMachO(path) {
  let handle;
  try {
    handle = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    const header = Buffer.alloc(4);
    if (readSync(handle, header, 0, 4, 0) < 4) return false;
    return MACH_O_MAGIC.has(header.readUInt32BE(0));
  } finally {
    closeSync(handle);
  }
}

function machOFiles(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    // Symlinks are skipped: framework layouts point several aliases at one
    // binary, and codesign already verifies the real path.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      machOFiles(path, found);
    } else if (entry.isFile() && statSync(path).size >= 4 && isMachO(path)) {
      found.push(path);
    }
  }
  return found;
}

function codesign(args) {
  // codesign writes its report to stderr, including on success.
  const result = spawnSync("codesign", args, { encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

export function verifyBundleSignature({ appPath }) {
  const app = resolve(appPath);
  const checks = [];
  const record = (name, passed, detail) => {
    checks.push({ name, passed, detail });
    return passed;
  };

  if (!record("bundle exists", existsSync(app), app)) {
    return { app, signed: false, error: "the .app bundle was not found", checks };
  }

  const seal = join(app, "Contents", "_CodeSignature", "CodeResources");
  record(
    "sealed resource directory",
    existsSync(seal),
    existsSync(seal) ? "Contents/_CodeSignature/CodeResources is present" : "Contents/_CodeSignature/CodeResources is missing — the bundle was never codesigned",
  );

  const verification = codesign(["--verify", "--strict", "--verbose=2", app]);
  record("codesign --verify --strict", verification.ok, verification.output);

  const display = codesign(["--display", "--verbose=2", app]);
  const sealedResources = /Sealed Resources version=\d+/.test(display.output);
  record(
    "resources are sealed",
    sealedResources,
    sealedResources ? display.output.match(/Sealed Resources version=\d+[^\n]*/)?.[0] : "Sealed Resources=none",
  );

  // linker-signed means the Rust linker's automatic ad-hoc signature is all that
  // exists; codesign never ran over the assembled bundle.
  const linkerSigned = /linker-signed/.test(display.output);
  record(
    "bundle is not merely linker-signed",
    !linkerSigned,
    display.output.match(/flags=0x[0-9a-f]+\([^)]*\)/)?.[0] ?? "no CodeDirectory flags reported",
  );

  // Bundled OCR binaries live under Contents/Resources rather than Frameworks,
  // so the bundle seal hashes them as data. tesseract is spawned as its own
  // process and needs a signature of its own to run on Apple Silicon.
  const binaries = machOFiles(join(app, "Contents"));
  record("bundle contains Mach-O binaries", binaries.length > 0, `${binaries.length} found`);
  for (const binary of binaries) {
    const nestedVerification = codesign(["--verify", "--strict", "--verbose=2", binary]);
    record(`signed: ${binary.slice(app.length + 1)}`, nestedVerification.ok, nestedVerification.output);
  }

  const signed = checks.every((check) => check.passed);
  return {
    app,
    signed,
    checks,
    error: signed ? undefined : "the macOS bundle is not correctly signed and would be reported as damaged",
  };
}

function option(name) {
  return process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function bundleDirectory({ target }) {
  const targetDirectory = target ? join("apps/desktop/src-tauri/target", target) : "apps/desktop/src-tauri/target";
  return join(targetDirectory, "release/bundle");
}

// The staged .app cannot be inspected after a build: the bundler logs
// "Cleaning .../bundle/macos/<name>.app" and deletes it once the DMG exists.
// Reading it back out of the disk image is not a workaround for that — it is the
// stronger check, because the DMG is the artifact that actually reaches a
// student, and nothing else verifies what ended up inside it.
export function verifyDiskImage({ dmgPath }) {
  const dmg = resolve(dmgPath);
  if (!existsSync(dmg)) {
    return { dmg, signed: false, error: "the DMG was not found", checks: [] };
  }
  const mountPoint = mkdtempSync(join(tmpdir(), "student-center-dmg-"));
  const attached = spawnSync(
    "hdiutil",
    ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountPoint, dmg],
    { encoding: "utf8" },
  );
  if (attached.status !== 0) {
    rmSync(mountPoint, { recursive: true, force: true });
    return { dmg, signed: false, error: `the DMG could not be mounted: ${attached.stderr?.trim()}`, checks: [] };
  }
  try {
    const app = readdirSync(mountPoint).find((entry) => entry.endsWith(".app"));
    if (!app) {
      return { dmg, signed: false, error: "the DMG contains no .app bundle", checks: [] };
    }
    return { dmg, ...verifyBundleSignature({ appPath: join(mountPoint, app) }) };
  } finally {
    spawnSync("hdiutil", ["detach", mountPoint, "-quiet"], { encoding: "utf8" });
    rmSync(mountPoint, { recursive: true, force: true });
  }
}

export function findDiskImage({ target }) {
  const directory = join(bundleDirectory({ target }), "dmg");
  if (!existsSync(directory)) return undefined;
  const dmg = readdirSync(directory).find((entry) => entry.endsWith(".dmg"));
  return dmg ? join(directory, dmg) : undefined;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.platform !== "darwin") {
    console.error("The macOS signature gate can only run on macOS.");
    process.exitCode = 1;
  } else {
    const target = option("--target");
    const appPath = option("--app");
    const dmgPath = option("--dmg") ?? (appPath ? undefined : findDiskImage({ target }));
    let result;
    if (appPath) {
      result = verifyBundleSignature({ appPath });
    } else if (dmgPath) {
      result = verifyDiskImage({ dmgPath });
    } else {
      result = { signed: false, error: `no DMG was found under ${join(bundleDirectory({ target }), "dmg")}`, checks: [] };
    }
    console.log(JSON.stringify(result, null, 2));
    if (!result.signed) {
      console.error(`macOS signature gate failed: ${result.error}.`);
      process.exitCode = 1;
    }
  }
}
