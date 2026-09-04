import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as native from "../src/native";
import { NotificationsSettings } from "../src/features/settings/NotificationsSettings";
import { DataRecoverySettings } from "../src/features/settings/DataRecoverySettings";
import { SettingsDetail } from "../src/components/SettingsDetail";
import { Modal } from "../src/components/Modal";
import { CanvasSettings } from "../src/features/settings/CanvasSettings";
import { AiSettings } from "../src/features/settings/AiSettings";
import { BackupSettings } from "../src/features/settings/BackupSettings";
import { SecuritySettings } from "../src/features/settings/SecuritySettings";

beforeEach(() => window.history.replaceState({}, "", "/?demo"));
afterEach(() => vi.restoreAllMocks());
const props = () => ({
  close: vi.fn(),
  onDashboard: vi.fn(),
  onToast: vi.fn(),
  onReview: vi.fn(),
});

test("Canvas clears submitted credentials and retains partial-success diagnostics", async () => {
  const data = await native.getDashboard();
  const result = {
    ...data,
    importNotice: "Imported usable events; 1 event needs correction.",
  };
  const connect = vi
    .spyOn(native, "connectCanvasCalendar")
    .mockResolvedValue(result);
  const callbacks = props();
  const user = userEvent.setup();
  render(
    <CanvasSettings data={{ ...data, canvasConnections: [] }} {...callbacks} />,
  );
  const feed = screen.getByLabelText("Canvas calendar feed link");
  await user.type(
    feed,
    "https://canvas.example.edu/feeds/calendars/synthetic-only.ics",
  );
  await user.click(
    screen.getByRole("button", { name: "Validate and connect" }),
  );
  await waitFor(() =>
    expect(callbacks.onDashboard).toHaveBeenCalledWith(result),
  );
  expect(feed).toHaveValue("");
  expect(connect).toHaveBeenCalledWith(
    "https://canvas.example.edu/feeds/calendars/synthetic-only.ics",
    "Canvas calendar",
    true,
  );
  expect(callbacks.onToast).toHaveBeenCalledWith(result.importNotice);
});

test("Canvas exposes pending review and opens it after a manual refresh", async () => {
  const data = await native.getDashboard();
  const connection: native.CanvasConnection = {
    id: "canvas-connection",
    provider: "canvas_calendar",
    baseUrl: "https://canvas.example.edu",
    accountName: "Canvas calendar",
    status: "connected",
    refreshOnStartup: true,
    pendingCandidates: 2,
  };
  const result = { ...data, canvasConnections: [connection] };
  vi.spyOn(native, "refreshCanvasCalendar").mockResolvedValue(result);
  const callbacks = props();
  const user = userEvent.setup();
  render(<CanvasSettings data={result} {...callbacks} />);

  await user.click(
    screen.getByRole("button", { name: "Review 2 pending" }),
  );
  expect(callbacks.onReview).toHaveBeenCalledWith(connection.id);

  callbacks.onReview.mockClear();
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(callbacks.onReview).toHaveBeenCalledWith(connection.id),
  );
});

test("AI settings require age/billing consent and clear the submitted secret even on failure", async () => {
  const providers = await native.listAiProviders();
  vi.spyOn(native, "listAiProviders").mockResolvedValue(providers);
  vi.spyOn(native, "getAiUsage").mockResolvedValue([]);
  const save = vi
    .spyOn(native, "saveAiProviderKey")
    .mockRejectedValue(new Error("Provider validation failed"));
  const user = userEvent.setup();
  render(
    <AiSettings
      aiProviders={providers}
      setAiProviders={vi.fn()}
      close={vi.fn()}
      setToast={vi.fn()}
    />,
  );
  await user.type(
    await screen.findByLabelText("API key"),
    "synthetic-provider-key-for-test",
  );
  const connect = screen.getByRole("button", { name: "Validate and connect" });
  expect(connect).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /I am 18 or older/ }));
  await user.click(connect);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Provider validation failed",
  );
  expect(screen.getByLabelText("API key")).toHaveValue("");
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0][3]).toBe(true);
});

const archive: native.BackupPreview = {
  fingerprint: "synthetic-fingerprint",
  archiveId: "synthetic-archive",
  createdAt: "2026-09-01T12:00:00Z",
  appVersion: "0.12.0",
  studentName: "Test Student",
  timezone: "America/Phoenix",
  encryptedBytes: 1234,
  counts: {
    tasks: 2,
    commitments: 1,
    courses: 1,
    documents: 0,
    pendingCandidates: 0,
  },
};
test("backup restore requires a current preview and explicit acknowledgment; failure never reports success", async () => {
  const data = await native.getDashboard();
  vi.spyOn(native, "isDesktop").mockReturnValue(true);
  vi.spyOn(native, "selectBackupFile").mockResolvedValue(
    "/synthetic/test.studentcenter",
  );
  const preview = vi
    .spyOn(native, "previewEncryptedBackup")
    .mockResolvedValue(archive);
  const restore = vi
    .spyOn(native, "restoreEncryptedBackup")
    .mockRejectedValueOnce(new Error("Archive changed; preview again"));
  const restored = vi.fn();
  const user = userEvent.setup();
  render(
    <BackupSettings close={vi.fn()} setToast={vi.fn()} onRestored={restored} />,
  );
  await user.click(screen.getByRole("button", { name: /Restore from backup/ }));
  await user.click(
    screen.getByRole("button", { name: /Choose a .studentcenter backup/ }),
  );
  await screen.findByText("test.studentcenter", { exact: true });
  await user.type(
    screen.getByLabelText("Backup passphrase"),
    "test-passphrase-only",
  );
  await user.click(screen.getByRole("button", { name: "Verify and preview" }));
  let replace = await screen.findByRole("button", {
    name: "Replace profile and restore",
  });
  expect(replace).toBeDisabled();
  await user.click(
    screen.getByRole("checkbox", { name: /Replace this local profile/ }),
  );
  await user.type(screen.getByLabelText("Backup passphrase"), "!");
  expect(
    screen.queryByRole("button", { name: "Replace profile and restore" }),
  ).not.toBeInTheDocument();
  expect(restore).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Verify and preview" }));
  replace = await screen.findByRole("button", {
    name: "Replace profile and restore",
  });
  expect(replace).toBeDisabled();
  await user.click(
    screen.getByRole("checkbox", { name: /Replace this local profile/ }),
  );
  await user.click(replace);
  expect(await screen.findByRole("alert")).toHaveTextContent("Archive changed");
  expect(restored).not.toHaveBeenCalled();
  restore.mockResolvedValueOnce(data);
  await user.click(replace);
  await waitFor(() => expect(restored).toHaveBeenCalledWith(data));
  expect(preview).toHaveBeenCalledTimes(2);
  expect(restore).toHaveBeenLastCalledWith(
    "/synthetic/test.studentcenter",
    "test-passphrase-only!",
    archive.fingerprint,
    true,
  );
  expect(screen.getByLabelText("Backup passphrase")).toHaveValue("");
});

test("App Lock validates confirmation and retains the form after a failed native save", async () => {
  vi.spyOn(native, "isDesktop").mockReturnValue(true);
  const save = vi
    .spyOn(native, "enablePin")
    .mockRejectedValueOnce(new Error("Local keychain unavailable"));
  const close = vi.fn();
  const setSecurity = vi.fn();
  const user = userEvent.setup();
  render(
    <SecuritySettings
      security={{ pinEnabled: false, locked: false, retryAfterSeconds: 0 }}
      setSecurity={setSecurity}
      setToast={vi.fn()}
      close={close}
      lockWorkspace={vi.fn()}
    />,
  );
  await user.type(
    screen.getByLabelText("New PIN or passphrase"),
    "test-pin-only",
  );
  const enable = screen.getByRole("button", { name: "Enable app lock" });
  expect(enable).toBeDisabled();
  await user.type(screen.getByLabelText("Confirm PIN"), "test-pin-only");
  await user.click(enable);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Local keychain unavailable",
  );
  expect(close).not.toHaveBeenCalled();
  expect(setSecurity).not.toHaveBeenCalled();
  expect(screen.getByLabelText("New PIN or passphrase")).toHaveValue(
    "test-pin-only",
  );
  expect(save).toHaveBeenCalledWith("test-pin-only");
});

test("notification save failure retains edited fields; retry closes only after persistence", async () => {
  const data = await native.getDashboard();
  vi.spyOn(native, "isDesktop").mockReturnValue(true);
  const save = vi
    .spyOn(native, "updateNotificationSettings")
    .mockRejectedValueOnce(new Error("Unable to save reminders"));
  const callbacks = props();
  const user = userEvent.setup();
  render(<NotificationsSettings data={data} {...callbacks} />);
  const lead = screen.getByRole("spinbutton");
  await user.clear(lead);
  await user.type(lead, "25");
  await user.click(
    screen.getByRole("button", { name: "Save reminder settings" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Unable to save reminders",
  );
  expect(lead).toHaveValue(25);
  expect(callbacks.close).not.toHaveBeenCalled();
  expect(callbacks.onDashboard).not.toHaveBeenCalled();
  save.mockResolvedValueOnce(data);
  await user.click(
    screen.getByRole("button", { name: "Save reminder settings" }),
  );
  await waitFor(() => expect(callbacks.close).toHaveBeenCalledOnce());
  expect(save).toHaveBeenLastCalledWith(
    data.notificationSettings.enabled,
    25,
    "22:00",
    "07:00",
    false,
  );
  expect(callbacks.onDashboard).toHaveBeenCalledWith(data);
});

test("notification delivery is explicitly unavailable in browser previews", async () => {
  render(
    <NotificationsSettings data={await native.getDashboard()} {...props()} />,
  );
  expect(
    screen.getByRole("button", { name: "Save reminder settings" }),
  ).toBeDisabled();
  expect(
    screen.getByText(/available in the installed desktop app/),
  ).toBeInTheDocument();
});

const item = {
  id: "legacy-one",
  entityType: "task",
  title: "Synthetic recovery record",
  quarantinedAt: "2026-08-01T12:00:00Z",
};
test("recovery distinguishes load failure from an empty vault and supports retry", async () => {
  vi.spyOn(native, "listLegacyQuarantine")
    .mockRejectedValueOnce(new Error("Recovery unavailable"))
    .mockResolvedValueOnce([item]);
  const user = userEvent.setup();
  render(<DataRecoverySettings {...props()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Recovery unavailable",
  );
  expect(screen.queryByText("No quarantined records")).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Reload recovery records" }),
  );
  expect(await screen.findByText(item.title)).toBeInTheDocument();
});

test("recovery writes never remove records on failure and purge requires its exact confirmation", async () => {
  vi.spyOn(native, "listLegacyQuarantine").mockResolvedValue([item]);
  const restore = vi
    .spyOn(native, "restoreLegacyQuarantine")
    .mockRejectedValueOnce(new Error("Restore failed"));
  const purge = vi
    .spyOn(native, "purgeLegacyQuarantine")
    .mockRejectedValueOnce(new Error("Purge failed"));
  const callbacks = props();
  const user = userEvent.setup();
  render(<DataRecoverySettings {...callbacks} />);
  await user.click(
    await screen.findByRole("button", { name: "Restore", exact: true }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Restore failed");
  expect(screen.getByText(item.title)).toBeInTheDocument();
  expect(restore).toHaveBeenCalledWith([item.id]);
  const purgeButton = screen.getByRole("button", {
    name: "Permanently purge snapshots",
  });
  expect(purgeButton).toBeDisabled();
  await user.type(screen.getByRole("textbox"), "PURGE LEGACY DATA");
  await user.click(purgeButton);
  expect(await screen.findByRole("alert")).toHaveTextContent("Purge failed");
  expect(screen.getByText(item.title)).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue("PURGE LEGACY DATA");
  expect(purge).toHaveBeenCalledWith("PURGE LEGACY DATA");
  expect(callbacks.onToast).not.toHaveBeenCalled();
});

test("Escape in a transient dialog does not also leave its underlying settings page", async () => {
  const closePage = vi.fn();
  const closeDialog = vi.fn();
  const user = userEvent.setup();
  render(
    <>
      <SettingsDetail
        title="Settings section"
        subtitle="Test section"
        close={closePage}
      >
        <p>Settings content</p>
      </SettingsDetail>
      <Modal title="Review changes" subtitle="Test review" close={closeDialog}>
        <button>Confirm</button>
      </Modal>
    </>,
  );
  await user.keyboard("{Escape}");
  expect(closeDialog).toHaveBeenCalledOnce();
  expect(closePage).not.toHaveBeenCalled();
});
