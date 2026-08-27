import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The native smoke deletes its profile during teardown. Give the WebDriver-only
// build a unique disposable root so a local run can never touch the real app.
process.env.STUDENT_CENTER_E2E_DATA_DIR ??= mkdtempSync(
  path.join(tmpdir(), "coqui-student-center-e2e-"),
);

const fallback = process.platform === "win32"
  ? "apps/desktop/src-tauri/target/release/student-center.exe"
  : "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/student-center";
const appBinaryPath = path.resolve(process.env.STUDENT_CENTER_E2E_BINARY ?? fallback);

export const config = {
  runner: "local",
  specs: ["./specs/**/*.spec.mjs"],
  maxInstances: 1,
  capabilities: [{ browserName: "tauri", "tauri:options": { application: appBinaryPath } }],
  services: [["@wdio/tauri-service", {
    appBinaryPath,
    driverProvider: "embedded",
    embeddedPort: 4445,
    startTimeout: 90_000,
    statusPollTimeout: 5_000,
    captureBackendLogs: true,
    captureFrontendLogs: true
  }]],
  framework: "mocha",
  reporters: ["spec"],
  logLevel: "warn",
  waitforTimeout: 15_000,
  connectionRetryTimeout: 90_000,
  connectionRetryCount: 2,
  mochaOpts: { ui: "bdd", timeout: 60_000 }
};
