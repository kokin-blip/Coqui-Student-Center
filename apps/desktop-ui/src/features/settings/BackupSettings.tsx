import { useState } from "react";
import {
  FileLock2,
  RefreshCw,
  ChevronRight,
  CircleAlert,
  ShieldCheck,
  HardDrive,
} from "lucide-react";
import { SettingsDetail } from "../../components/SettingsDetail";
import { BackupSummary } from "../../components/SecurityPrimitives";
import {
  isDesktop,
  exportEncryptedBackup,
  selectBackupFile,
  previewEncryptedBackup,
  restoreEncryptedBackup,
  type Dashboard,
  type BackupPreview,
} from "../../native";
export function BackupSettings({
  close,
  setToast,
  onRestored,
}: {
  close: () => void;
  setToast: (message: string) => void;
  onRestored: (data: Dashboard) => void;
}) {
  const [backupView, setBackupView] = useState<"home" | "export" | "restore">(
    "home",
  );
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupConfirmation, setBackupConfirmation] = useState("");
  const [backupPath, setBackupPath] = useState("");
  const [backupPreview, setBackupPreview] = useState<BackupPreview | null>(
    null,
  );
  const [restoreAcknowledged, setRestoreAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const resetBackupFields = () => {
    setBackupPassphrase("");
    setBackupConfirmation("");
    setBackupPath("");
    setBackupPreview(null);
    setRestoreAcknowledged(false);
    setError("");
  };
  const switchBackupView = (view: "home" | "export" | "restore") => {
    resetBackupFields();
    setBackupView(view);
  };
  const closeBackups = () => {
    if (busy) return;
    resetBackupFields();
    close();
  };
  const createBackup = async () => {
    setBusy(true);
    setError("");
    try {
      const preview = await exportEncryptedBackup(backupPassphrase);
      if (preview) {
        setBackupPreview(preview);
        setBackupPassphrase("");
        setBackupConfirmation("");
        setToast("Encrypted backup created and verified.");
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const chooseRestore = async () => {
    setBusy(true);
    setError("");
    try {
      const path = await selectBackupFile();
      if (path) {
        setBackupPath(path);
        setBackupPassphrase("");
        setBackupPreview(null);
        setRestoreAcknowledged(false);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const inspectBackup = async () => {
    setBusy(true);
    setError("");
    try {
      setBackupPreview(
        await previewEncryptedBackup(backupPath, backupPassphrase),
      );
      setRestoreAcknowledged(false);
    } catch (reason) {
      setBackupPreview(null);
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const restoreBackup = async () => {
    if (!backupPreview || !restoreAcknowledged) return;
    setBusy(true);
    setError("");
    try {
      const next = await restoreEncryptedBackup(
        backupPath,
        backupPassphrase,
        backupPreview.fingerprint,
        restoreAcknowledged,
      );
      resetBackupFields();
      onRestored(next);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsDetail
      title="Encrypted backups"
      subtitle="Create a portable archive or inspect one before replacing this local profile."
      close={closeBackups}
    >
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <fieldset className="settings-fields" disabled={busy}>
        <legend className="sr-only">Encrypted backup settings</legend>
        {backupView === "home" && (
          <div className="backup-options">
            <button onClick={() => switchBackupView("export")}>
              <FileLock2 />
              <span>
                <strong>Create encrypted backup</strong>
                <small>
                  Save the complete database and document vault under a
                  passphrase.
                </small>
              </span>
              <ChevronRight />
            </button>
            <button onClick={() => switchBackupView("restore")}>
              <RefreshCw />
              <span>
                <strong>Restore from backup</strong>
                <small>
                  Verify an archive, review its contents, then explicitly
                  replace this profile.
                </small>
              </span>
              <ChevronRight />
            </button>
            {!isDesktop() && (
              <p className="privacy-note">
                <CircleAlert /> Backup operations are available only in the
                installed desktop application.
              </p>
            )}
          </div>
        )}
        {backupView === "export" && (
          <>
            <div className="consent-box">
              <ShieldCheck />
              <div>
                <strong>Portable, end-to-end encrypted archive</strong>
                <p>
                  The database and vault stay encrypted. Keep this passphrase
                  safe: Student Center cannot recover it.
                </p>
              </div>
            </div>
            <label className="field">
              Backup passphrase
              <input
                type="password"
                autoFocus
                value={backupPassphrase}
                onChange={(event) => setBackupPassphrase(event.target.value)}
                autoComplete="new-password"
                placeholder="At least 12 characters"
              />
            </label>
            <label className="field">
              Confirm passphrase
              <input
                type="password"
                value={backupConfirmation}
                onChange={(event) => setBackupConfirmation(event.target.value)}
                autoComplete="new-password"
              />
            </label>
            {backupPreview && (
              <BackupSummary
                preview={backupPreview}
                title="Backup created and verified"
              />
            )}
            <div className="modal-actions">
              <button
                className="outline"
                onClick={() => switchBackupView("home")}
              >
                Back
              </button>
              <button
                className="solid"
                disabled={
                  busy ||
                  !isDesktop() ||
                  backupPassphrase.length < 12 ||
                  backupPassphrase !== backupConfirmation
                }
                onClick={createBackup}
              >
                Choose location and create
              </button>
            </div>
          </>
        )}
        {backupView === "restore" && (
          <>
            {!backupPath ? (
              <button
                className="dropzone"
                disabled={busy || !isDesktop()}
                onClick={chooseRestore}
              >
                <HardDrive />
                <strong>Choose a .studentcenter backup</strong>
                <span>
                  The archive is read and verified before anything changes.
                </span>
              </button>
            ) : (
              <div className="selected-backup">
                <HardDrive />
                <span>
                  <strong>{backupPath.split(/[\\/]/).at(-1)}</strong>
                  <small>{backupPath}</small>
                </span>
                <button
                  className="outline"
                  disabled={busy}
                  onClick={chooseRestore}
                >
                  Change
                </button>
              </div>
            )}
            <label className="field">
              Backup passphrase
              <input
                type="password"
                value={backupPassphrase}
                onChange={(event) => {
                  setBackupPassphrase(event.target.value);
                  setBackupPreview(null);
                  setRestoreAcknowledged(false);
                }}
                autoComplete="current-password"
                placeholder="Required to inspect the archive"
              />
            </label>
            {backupPreview ? (
              <>
                <BackupSummary
                  preview={backupPreview}
                  title="Verified backup"
                />
                <label className="restore-confirm">
                  <input
                    type="checkbox"
                    checked={restoreAcknowledged}
                    onChange={(event) =>
                      setRestoreAcknowledged(event.target.checked)
                    }
                  />
                  <span>
                    <strong>Replace this local profile</strong>
                    <small>
                      I understand the current database and document vault will
                      be replaced. Integration and AI credentials are not
                      restored.
                    </small>
                  </span>
                </label>
                <div className="modal-actions">
                  <button
                    className="outline"
                    onClick={() => switchBackupView("home")}
                  >
                    Cancel
                  </button>
                  <button
                    className="solid danger-solid"
                    disabled={busy || !restoreAcknowledged}
                    onClick={restoreBackup}
                  >
                    Replace profile and restore
                  </button>
                </div>
              </>
            ) : (
              <div className="modal-actions">
                <button
                  className="outline"
                  onClick={() => switchBackupView("home")}
                >
                  Back
                </button>
                <button
                  className="solid"
                  disabled={busy || !backupPath || backupPassphrase.length < 12}
                  onClick={inspectBackup}
                >
                  Verify and preview
                </button>
              </div>
            )}
          </>
        )}
      </fieldset>
    </SettingsDetail>
  );
}
