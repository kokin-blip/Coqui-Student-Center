import { createHash } from "node:crypto";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const roots = [
  "apps/desktop/src-tauri/target/release/bundle/nsis",
  "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg",
  "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos",
];

// GitHub replaces spaces in uploaded asset names. Normalize before hashing so
// downloaded checksum files can be used directly with sha256sum/shasum -c.
const githubNames = process.argv.includes("--github");
let written = 0;
for (const root of roots) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(exe|dmg|zip)$|\.app\.tar\.gz$/i.test(entry.name)) continue;
    const filename = githubNames ? entry.name.replace(/ /g, ".") : entry.name;
    const artifact = path.join(root, filename);
    if (filename !== entry.name) {
      if (entries.some((item) => item.name === filename)) {
        throw new Error(`GitHub asset name collision: ${filename}`);
      }
      const original = path.join(root, entry.name);
      await rename(original, artifact);
      for (const suffix of [".sig", ".sha256"]) {
        try {
          await rename(`${original}${suffix}`, `${artifact}${suffix}`);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    }
    const digest = createHash("sha256").update(await readFile(artifact)).digest("hex");
    await writeFile(`${artifact}.sha256`, `${digest}  ${filename}\n`, "utf8");
    console.log(`${digest}  ${artifact}`);
    written += 1;
  }
}

if (written === 0) {
  throw new Error("No Windows NSIS or Apple Silicon DMG artifacts were found.");
}
