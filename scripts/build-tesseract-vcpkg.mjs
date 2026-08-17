import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const baseline = "aae277acf4e7de287ddb5e208b5316614de6aad7";

function option(name) {
  return process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? "no status"}`);
  }
}

const root = resolve(option("--root") ?? ".ocr-vcpkg");
const triplet = option("--triplet") ?? (process.platform === "win32" ? "x64-windows-static" : "arm64-osx-static");
const executable = process.platform === "win32" ? join(root, "vcpkg.exe") : join(root, "vcpkg");
const installRoot = join(root, "installed");

// vcpkg exits before doing anything if VCPKG_DEFAULT_BINARY_CACHE names a path
// that does not exist, and actions/cache does not create the directory when it
// misses -- which is every first run on a new cache key.
if (process.env.VCPKG_DEFAULT_BINARY_CACHE) {
  mkdirSync(process.env.VCPKG_DEFAULT_BINARY_CACHE, { recursive: true });
}

if (!existsSync(join(root, ".git"))) {
  mkdirSync(root, { recursive: true });
  run("git", ["init", root]);
  run("git", ["-C", root, "remote", "add", "origin", "https://github.com/microsoft/vcpkg.git"]);
}
run("git", ["-C", root, "fetch", "--depth=1", "origin", baseline]);
run("git", ["-C", root, "checkout", "--detach", "--force", baseline]);

if (process.platform === "win32") {
  run(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/c", "bootstrap-vcpkg.bat", "-disableMetrics"],
    { cwd: root },
  );
} else {
  run("bash", [join(root, "bootstrap-vcpkg.sh"), "-disableMetrics"]);
}

const installArguments = ["install", `tesseract:${triplet}`, `--x-install-root=${installRoot}`];
if (triplet === "arm64-osx-static") {
  installArguments.push(`--overlay-triplets=${resolve("scripts/ocr/triplets")}`);
}
run(executable, installArguments);

const tripletRoot = join(installRoot, triplet);
const tesseractName = process.platform === "win32" ? "tesseract.exe" : "tesseract";
if (!existsSync(join(tripletRoot, "tools", "tesseract", tesseractName))) {
  throw new Error(`vcpkg did not produce ${tesseractName} under ${tripletRoot}`);
}
console.log(JSON.stringify({ baseline, triplet, tripletRoot }, null, 2));
