const required = [
  "STUDENT_CENTER_UPDATER_ENDPOINT",
  "STUDENT_CENTER_UPDATER_PUBLIC_KEY",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
];

for (const name of required) {
  if (!process.env[name]?.trim()) {
    throw new Error(`${name} must be configured for a signed updater release.`);
  }
}

const endpoint = new URL(process.env.STUDENT_CENTER_UPDATER_ENDPOINT);
if (
  endpoint.protocol !== "https:" ||
  !endpoint.hostname ||
  endpoint.username ||
  endpoint.password ||
  endpoint.hash
) {
  throw new Error(
    "STUDENT_CENTER_UPDATER_ENDPOINT must be an HTTPS URL without credentials or a fragment.",
  );
}
if (process.env.STUDENT_CENTER_UPDATER_PUBLIC_KEY.trim().length < 32) {
  throw new Error("STUDENT_CENTER_UPDATER_PUBLIC_KEY is not a valid trust anchor.");
}

console.log("Signed updater release configuration is present and structurally valid.");
