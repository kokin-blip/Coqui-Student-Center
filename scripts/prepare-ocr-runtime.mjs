import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const resourceRoot = resolve("apps/desktop/src-tauri/resources/ocr");
const sourcePath = join(resourceRoot, "runtime-sources.json");
const sourceBytes = readFileSync(sourcePath);
const sources = JSON.parse(sourceBytes.toString("utf8"));

function option(name) {
  return process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

const target = option("--target") ?? (process.platform === "win32" && process.arch === "x64"
  ? "windows-x64"
  : process.platform === "darwin" && process.arch === "arm64"
    ? "macos-arm64"
    : "unsupported");
const tesseractRoot = option("--tesseract-root");
const outputRoot = resolve(option("--root") ?? resourceRoot);
const targetRoot = resolve(outputRoot, target);
const expectedPrefix = `${outputRoot}${sep}`;

if (!(targetRoot === outputRoot || targetRoot.startsWith(expectedPrefix))) {
  throw new Error(`refusing to prepare OCR outside ${outputRoot}`);
}
if (!sources.pdfium.assets[target]) {
  throw new Error(`unsupported OCR runtime target ${target}`);
}
if (!tesseractRoot) {
  throw new Error("--tesseract-root=<vcpkg triplet directory> is required");
}

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const temporary = mkdtempSync(join(tmpdir(), "student-center-ocr-"));

async function download(url, expectedSha256, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed (${response.status}) for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = hash(bytes);
  if (actual !== expectedSha256) {
    throw new Error(`SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actual}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
  return bytes;
}

function findTesseract(root) {
  const executable = target === "windows-x64" ? "tesseract.exe" : "tesseract";
  const candidates = [
    join(root, "tools", "tesseract", executable),
    join(root, "bin", executable),
    join(root, executable),
  ];
  const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!found) throw new Error(`could not find ${executable} under ${root}`);
  return found;
}

function copyVcpkgLicenses(root, destination) {
  const share = join(root, "share");
  if (!existsSync(share)) throw new Error(`vcpkg share directory is missing under ${root}`);
  let copied = 0;
  for (const entry of readdirSync(share, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const copyright = join(share, entry.name, "copyright");
    if (!existsSync(copyright)) continue;
    mkdirSync(destination, { recursive: true });
    copyFileSync(copyright, join(destination, `${entry.name}.txt`));
    copied += 1;
  }
  if (copied === 0) throw new Error("no vcpkg copyright files were found");
  return copied;
}

function filesBelow(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    return entry.isDirectory() ? filesBelow(root, path) : [relative(root, path).replaceAll("\\", "/")];
  });
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

try {
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });

  const pdfium = sources.pdfium.assets[target];
  const archive = join(temporary, basename(new URL(pdfium.url).pathname));
  await download(pdfium.url, pdfium.sha256, archive);
  const extracted = join(temporary, "pdfium");
  mkdirSync(extracted, { recursive: true });
  run("tar", ["-xzf", archive, "-C", extracted]);
  const pdfiumDestination = join(targetRoot, pdfium.destination);
  mkdirSync(dirname(pdfiumDestination), { recursive: true });
  mkdirSync(join(targetRoot, "licenses"), { recursive: true });
  copyFileSync(join(extracted, pdfium.library), pdfiumDestination);
  copyFileSync(join(extracted, "LICENSE"), join(targetRoot, "licenses", "pdfium-binaries-MIT.txt"));
  cpSync(join(extracted, "licenses"), join(targetRoot, "licenses", "pdfium"), { recursive: true });

  const tesseract = findTesseract(resolve(tesseractRoot));
  const tesseractDestination = join(targetRoot, "bin", target === "windows-x64" ? "tesseract.exe" : "tesseract");
  mkdirSync(dirname(tesseractDestination), { recursive: true });
  copyFileSync(tesseract, tesseractDestination);
  if (target !== "windows-x64") chmodSync(tesseractDestination, 0o755);
  const licenseCount = copyVcpkgLicenses(resolve(tesseractRoot), join(targetRoot, "licenses", "tesseract-vcpkg"));

  await download(
    sources.tessdataFast.englishUrl,
    sources.tessdataFast.englishSha256,
    join(targetRoot, "tessdata", "eng.traineddata"),
  );
  await download(
    sources.tessdataFast.licenseUrl,
    sources.tessdataFast.licenseSha256,
    join(targetRoot, "licenses", "tessdata-fast-Apache-2.0.txt"),
  );
  await download(
    sources.tessconfigs.tsvUrl,
    sources.tessconfigs.tsvSha256,
    join(targetRoot, "tessdata", "configs", "tsv"),
  );
  await download(
    sources.tessconfigs.licenseUrl,
    sources.tessconfigs.licenseSha256,
    join(targetRoot, "licenses", "tessconfigs-Apache-2.0.txt"),
  );
  await download(
    sources.tesseract.licenseUrl,
    sources.tesseract.licenseSha256,
    join(targetRoot, "licenses", "tesseract-Apache-2.0.txt"),
  );

  const languages = run(tesseractDestination, ["--tessdata-dir", join(targetRoot, "tessdata"), "--list-langs"]);
  if (!languages.split(/\r?\n/).some((language) => language.trim() === "eng")) {
    throw new Error("the staged Tesseract binary did not report the English model");
  }

  const notice = [
    "Student Center OCR Runtime",
    `Runtime: ${sources.runtimeVersion}`,
    `Target: ${target}`,
    "",
    `PDFium: ${sources.pdfium.tag} (${sources.pdfium.commit})`,
    `Tesseract: ${sources.tesseract.version} (${sources.tesseract.commit})`,
    `tessdata_fast: ${sources.tessdataFast.tag} (${sources.tessdataFast.commit})`,
    `tessconfigs: ${sources.tessconfigs.commit}`,
    `vcpkg baseline: ${sources.tesseract.vcpkgBaseline}`,
    `Collected vcpkg license files: ${licenseCount}`,
    "",
    "Exact component and transitive dependency notices are in licenses/.",
  ].join("\n");
  writeFileSync(join(targetRoot, "THIRD_PARTY_NOTICES.txt"), `${notice}\n`);

  const runtimeFiles = filesBelow(targetRoot).filter((path) => path !== "runtime-lock.json").sort();
  const lock = {
    schemaVersion: 1,
    target,
    runtimeVersion: sources.runtimeVersion,
    sourceManifestSha256: hash(sourceBytes),
    files: Object.fromEntries(runtimeFiles.map((path) => [path, hash(readFileSync(join(targetRoot, path)))])),
  };
  writeFileSync(join(targetRoot, "runtime-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  console.log(JSON.stringify({ target, runtimeVersion: sources.runtimeVersion, files: runtimeFiles.length, licenseCount }, null, 2));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
