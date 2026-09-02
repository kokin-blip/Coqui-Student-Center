import { useEffect, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import {
  checkForUpdates,
  getUpdateStatus,
  installUpdate,
  isDesktop,
  type UpdateStatus,
} from "../native";
import { Modal } from "./Modal";

type UpdateModalProps = {
  close: () => void;
};

export function UpdateModal({ close }: UpdateModalProps) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [installConfirmed, setInstallConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setBusy(true);
    getUpdateStatus()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch((next) => {
        if (active) setError(String(next));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const check = async () => {
    setBusy(true);
    setError("");
    try {
      setStatus(await checkForUpdates());
    } catch (next) {
      setError(String(next));
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (!status?.available || !status.latestVersion) return;
    setBusy(true);
    setError("");
    try {
      await installUpdate(status.latestVersion, installConfirmed);
    } catch (next) {
      setError(String(next));
      setInstallConfirmed(false);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Student Center updates"
      subtitle="Private-beta builds check only an HTTPS channel and accept installers signed by the public key embedded at build time."
      close={close}
    >
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {status ? (
        <>
          <div
            className={`update-state ${status.available ? "available" : status.configured ? "current" : "unconfigured"}`}
          >
            <RefreshCw />
            <span>
              <strong>
                {status.available
                  ? `Version ${status.latestVersion} is available`
                  : `Student Center ${status.currentVersion}`}
              </strong>
              <small>{status.message}</small>
            </span>
          </div>
          {status.notes && (
            <div className="release-notes">
              <strong>Release notes</strong>
              <p>{status.notes}</p>
            </div>
          )}
          <div className="consent-box">
            <ShieldCheck />
            <div>
              <strong>Signed artifacts only</strong>
              <p>
                Checking does not install anything. When you approve an update,
                the native app downloads it, verifies the signature against the
                key embedded in this build, installs it, and restarts Student
                Center.
              </p>
            </div>
          </div>
          {status.available && status.latestVersion && (
            <label className="consent-check">
              <input
                type="checkbox"
                checked={installConfirmed}
                onChange={(event) => setInstallConfirmed(event.target.checked)}
              />
              <span>
                Install version {status.latestVersion} and restart the app.
                Unsaved form text may be lost.
              </span>
            </label>
          )}
          {status.checkedAt && (
            <p className="privacy-note">
              Last checked {new Date(status.checkedAt).toLocaleString()}
            </p>
          )}
          <div className="modal-actions">
            <button className="outline" onClick={close}>
              Close
            </button>
            <button
              className="solid"
              disabled={busy || !isDesktop() || !status.configured}
              onClick={() => void check()}
            >
              <RefreshCw /> {busy ? "Checking…" : "Check for updates"}
            </button>
            {status.available && status.latestVersion && (
              <button
                className="solid"
                disabled={busy || !isDesktop() || !installConfirmed}
                onClick={() => void install()}
              >
                <ShieldCheck /> {busy ? "Installing…" : "Install signed update"}
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="empty" role="status">
          {busy ? "Loading update configuration…" : "Update configuration unavailable."}
        </div>
      )}
    </Modal>
  );
}
