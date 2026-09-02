import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const roots = [
  "apps/desktop/src-tauri/target/release/bundle/nsis",
  "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg",
  "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos",
];

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
    const artifact = path.join(root, entry.name);
    const digest = createHash("sha256").update(await readFile(artifact)).digest("hex");
    await writeFile(`${artifact}.sha256`, `${digest}  ${entry.name}\n`, "utf8");
    console.log(`${digest}  ${artifact}`);
    written += 1;
  }
}

if (written === 0) {
  throw new Error("No Windows NSIS or Apple Silicon DMG artifacts were found.");
}
