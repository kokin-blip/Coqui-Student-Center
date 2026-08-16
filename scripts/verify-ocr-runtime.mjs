import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function verifyRuntime({ root, target, strict = false }) {
  const sourcePath = join(root, "runtime-sources.json");
  const lockPath = join(root, target, "runtime-lock.json");
  if (!existsSync(sourcePath)) {
    return { target, ready: false, error: "runtime-sources.json is missing", checks: [] };
  }
  if (!existsSync(lockPath)) {
    return { target, ready: false, error: "runtime-lock.json is missing", checks: [] };
  }
  const sourceBytes = readFileSync(sourcePath);
  const sources = JSON.parse(sourceBytes.toString("utf8"));
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const sourceManifestVerified = lock.sourceManifestSha256 === sha256(sourceBytes);
  const identityVerified = lock.target === target && lock.runtimeVersion === sources.runtimeVersion;
  const checks = Object.entries(lock.files ?? {}).map(([relativePath, expected]) => {
    const absolutePath = join(root, target, relativePath);
    const present = existsSync(absolutePath);
    const actual = present ? sha256(readFileSync(absolutePath)) : null;
    return { relativePath, present, expected, actual, verified: present && expected === actual };
  });
  const ready = sourceManifestVerified && identityVerified && checks.length > 0 && checks.every((check) => check.verified);
  return {
    target,
    runtimeVersion: lock.runtimeVersion,
    ready,
    sourceManifestVerified,
    identityVerified,
    checks,
    error: strict && !ready ? "every runtime file and the source manifest must match the generated lock" : undefined,
  };
}

function option(name) {
  return process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(option("--root") ?? "apps/desktop/src-tauri/resources/ocr");
  const requested = option("--target");
  const target = requested ?? (process.platform === "win32" && process.arch === "x64"
    ? "windows-x64"
    : process.platform === "darwin" && process.arch === "arm64"
      ? "macos-arm64"
      : "unsupported");
  const strict = process.argv.includes("--require-ready");
  const result = verifyRuntime({ root, target, strict });
  console.log(JSON.stringify(result, null, 2));
  if (strict && !result.ready) {
    console.error(`OCR release gate failed: ${result.error ?? "runtime is not verified"}.`);
    process.exitCode = 1;
  }
}
