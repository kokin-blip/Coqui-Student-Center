import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const root = argument("artifacts");
const repository = argument("repository");
const tag = argument("tag");
const output = argument("output") ?? "latest.json";
if (!root || !repository || !tag || !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(
    "Usage: create-updater-manifest --artifacts=<dir> --repository=<owner/repo> --tag=<vX.Y.Z> [--output=<file>]",
  );
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error("The repository must be an owner/name pair.");
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

const files = await filesUnder(root);
const specifications = [
  { platform: "darwin-aarch64", suffix: ".app.tar.gz" },
  { platform: "windows-x86_64", suffix: ".nsis.zip" },
];
const platforms = {};
for (const specification of specifications) {
  const matches = files.filter((file) => file.endsWith(specification.suffix));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${specification.suffix} updater artifact; found ${matches.length}.`,
    );
  }
  const artifact = matches[0];
  const signaturePath = `${artifact}.sig`;
  if (!files.includes(signaturePath)) {
    throw new Error(`Missing updater signature for ${path.basename(artifact)}.`);
  }
  const signature = (await readFile(signaturePath, "utf8")).trim();
  if (signature.length < 32 || /\s/.test(signature)) {
    throw new Error(`Updater signature for ${path.basename(artifact)} is invalid.`);
  }
  const asset = encodeURIComponent(path.basename(artifact));
  platforms[specification.platform] = {
    signature,
    url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${asset}`,
  };
}

const manifest = {
  version: tag.replace(/^v/, ""),
  notes: `See the ${tag} release notes for verified changes and migration details.`,
  pub_date: new Date().toISOString(),
  platforms,
};
const json = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(output, json, "utf8");
const digest = createHash("sha256").update(json).digest("hex");
await writeFile(`${output}.sha256`, `${digest}  ${path.basename(output)}\n`, "utf8");
console.log(`Created ${output} with signed updater entries for ${Object.keys(platforms).join(", ")}.`);
