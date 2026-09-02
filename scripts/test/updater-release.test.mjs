import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = path.resolve("scripts/create-updater-manifest.mjs");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "coqui-updater-"));
  const mac = path.join(root, "mac");
  const windows = path.join(root, "windows");
  await mkdir(mac);
  await mkdir(windows);
  const artifacts = [
    path.join(mac, "Coqui.app.tar.gz"),
    path.join(windows, "Coqui.nsis.zip"),
  ];
  for (const artifact of artifacts) {
    await writeFile(artifact, "signed bundle fixture");
    await writeFile(`${artifact}.sig`, "R".repeat(88));
  }
  return { root, artifacts };
}

test("updater manifest pairs each platform artifact with its signature", async () => {
  const { root } = await fixture();
  const output = path.join(root, "latest.json");
  const result = spawnSync(
    process.execPath,
    [script, `--artifacts=${root}`, "--repository=kokin-blip/Coqui-Student-Center", "--tag=v1.2.3", `--output=${output}`],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(output, "utf8"));
  assert.equal(manifest.version, "1.2.3");
  assert.match(manifest.platforms["darwin-aarch64"].url, /Coqui\.app\.tar\.gz$/);
  assert.match(manifest.platforms["windows-x86_64"].url, /Coqui\.nsis\.zip$/);
  assert.match(await readFile(`${output}.sha256`, "utf8"), /^[a-f0-9]{64}  latest\.json\n$/);
});

test("updater manifest refuses an unsigned artifact", async () => {
  const { root, artifacts } = await fixture();
  await writeFile(`${artifacts[1]}.sig`, "short");
  const result = spawnSync(
    process.execPath,
    [script, `--artifacts=${root}`, "--repository=kokin-blip/Coqui-Student-Center", "--tag=v1.2.3"],
    { encoding: "utf8", cwd: root },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /signature.*invalid/i);
});

test("unsigned prereleases publish only after both packaged desktop lanes", async () => {
  const workflow = await readFile(".github/workflows/release.yml", "utf8");
  assert.match(workflow, /release_mode:[\s\S]*default: unsigned/);
  assert.match(workflow, /name: Build unsigned installers[\s\S]*npm run desktop:build/);
  assert.match(workflow, /publish-unsigned:\n\s+needs: build-packages/);
  assert.match(workflow, /name: Smoke Windows installer/);
  assert.match(workflow, /name: Smoke mounted macOS package/);
  assert.match(workflow, /Refusing to touch an existing Coqui profile/);
  assert.match(workflow, /foreach \(\$launch in 1\.\.2\)/);
  assert.match(workflow, /for launch in 1 2; do/);
  assert.match(workflow, /test ! -e "\$profile_root"/);
  assert.match(workflow, /codesign --verify --deep --strict/);
  const buildJob = workflow.slice(
    workflow.indexOf("  build-packages:"),
    workflow.indexOf("  publish-unsigned:"),
  );
  assert.doesNotMatch(
    buildJob,
    /softprops\/action-gh-release/,
    "a matrix leg must never publish a half-finished prerelease",
  );
});

test("0.12.0 is aligned across desktop release manifests", async () => {
  const root = JSON.parse(await readFile("package.json", "utf8"));
  const desktop = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));
  const ui = JSON.parse(await readFile("apps/desktop-ui/package.json", "utf8"));
  const tauri = JSON.parse(
    await readFile("apps/desktop/src-tauri/tauri.conf.json", "utf8"),
  );
  const cargo = await readFile("apps/desktop/src-tauri/Cargo.toml", "utf8");
  for (const manifest of [root, desktop, ui, tauri]) {
    assert.equal(manifest.version, "0.12.0");
  }
  assert.match(cargo, /^version = "0\.12\.0"$/m);
});
