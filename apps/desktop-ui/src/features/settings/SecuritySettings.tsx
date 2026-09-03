import { useState } from "react";
import {
  LockKeyhole,
  Settings,
  ChevronRight,
  Unplug,
  ShieldCheck,
  CircleAlert,
} from "lucide-react";
import { SettingsDetail } from "../../components/SettingsDetail";
import {
  enablePin,
  changePin,
  disablePin,
  isDesktop,
  type SecurityStatus,
} from "../../native";
export function SecuritySettings({
  security,
  setSecurity,
  close,
  setToast,
  lockWorkspace,
}: {
  security: SecurityStatus | null;
  setSecurity: (status: SecurityStatus) => void;
  close: () => void;
  setToast: (message: string) => void;
  lockWorkspace: () => Promise<void>;
}) {
  const [pinMode, setPinMode] = useState<
    "home" | "enable" | "change" | "disable"
  >(security?.pinEnabled ? "home" : "enable");
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [pinConfirmation, setPinConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const resetPinFields = () => {
    setCurrentPin("");
    setNewPin("");
    setPinConfirmation("");
  };
  const closeSecurity = () => {
    if (busy) return;
    resetPinFields();
    close();
  };
  const savePin = async () => {
    setBusy(true);
    setError("");
    try {
      const next =
        pinMode === "enable"
          ? await enablePin(newPin)
          : pinMode === "change"
            ? await changePin(currentPin, newPin)
            : await disablePin(currentPin);
      setSecurity(next);
      resetPinFields();
      setToast(
        pinMode === "disable"
          ? "App PIN disabled."
          : pinMode === "change"
            ? "App PIN changed."
            : "App PIN enabled.",
      );
      close();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsDetail
      title="App lock"
      subtitle="Add a private gate when you step away from this computer."
      close={closeSecurity}
    >
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <fieldset className="settings-fields" disabled={busy}>
        <legend className="sr-only">App lock settings</legend>
        {pinMode === "home" && (
          <>
            <div className="security-state">
              <LockKeyhole />
              <span>
                <strong>Student Center PIN is enabled</strong>
                <small>
                  The app locks again after a restart or when you choose Lock
                  now.
                </small>
              </span>
            </div>
            <div className="backup-options">
              <button
                onClick={() => {
                  resetPinFields();
                  setPinMode("change");
                }}
              >
                <Settings />
                <span>
                  <strong>Change PIN</strong>
                  <small>
                    Verify the current PIN, then choose a replacement.
                  </small>
                </span>
                <ChevronRight />
              </button>
              <button
                onClick={() => {
                  resetPinFields();
                  setPinMode("disable");
                }}
              >
                <Unplug />
                <span>
                  <strong>Disable app lock</strong>
                  <small>
                    The signed-in operating-system account will continue
                    protecting the device key.
                  </small>
                </span>
                <ChevronRight />
              </button>
            </div>
            <div className="modal-actions">
              <button
                className="solid"
                disabled={busy || !isDesktop()}
                onClick={lockWorkspace}
              >
                <LockKeyhole /> Lock now
              </button>
            </div>
          </>
        )}
        {pinMode === "enable" && (
          <>
            <div className="consent-box">
              <ShieldCheck />
              <div>
                <strong>An extra local privacy gate</strong>
                <p>
                  Your PIN is processed only on this computer with Argon2id. It
                  is never stored and cannot be recovered.
                </p>
              </div>
            </div>
            <label className="field">
              New PIN or passphrase
              <input
                type="password"
                autoFocus
                value={newPin}
                onChange={(event) => setNewPin(event.target.value)}
                autoComplete="new-password"
                placeholder="At least 6 characters"
              />
            </label>
            <label className="field">
              Confirm PIN
              <input
                type="password"
                value={pinConfirmation}
                onChange={(event) => setPinConfirmation(event.target.value)}
                autoComplete="new-password"
              />
            </label>
            <p className="privacy-note">
              <CircleAlert /> Forgotten PINs cannot be recovered from Student
              Center. Your operating-system account still protects the
              underlying device key.
            </p>
            <div className="modal-actions">
              <button className="outline" onClick={closeSecurity}>
                Cancel
              </button>
              <button
                className="solid"
                disabled={
                  busy ||
                  !isDesktop() ||
                  newPin.length < 6 ||
                  newPin !== pinConfirmation
                }
                onClick={savePin}
              >
                Enable app lock
              </button>
            </div>
          </>
        )}
        {pinMode === "change" && (
          <>
            <label className="field">
              Current PIN
              <input
                type="password"
                autoFocus
                value={currentPin}
                onChange={(event) => setCurrentPin(event.target.value)}
                autoComplete="current-password"
              />
            </label>
            <label className="field">
              New PIN or passphrase
              <input
                type="password"
                value={newPin}
                onChange={(event) => setNewPin(event.target.value)}
                autoComplete="new-password"
                placeholder="At least 6 characters"
              />
            </label>
            <label className="field">
              Confirm new PIN
              <input
                type="password"
                value={pinConfirmation}
                onChange={(event) => setPinConfirmation(event.target.value)}
                autoComplete="new-password"
              />
            </label>
            <div className="modal-actions">
              <button
                className="outline"
                onClick={() => {
                  resetPinFields();
                  setPinMode("home");
                }}
              >
                Back
              </button>
              <button
                className="solid"
                disabled={
                  busy ||
                  currentPin.length < 6 ||
                  newPin.length < 6 ||
                  newPin !== pinConfirmation
                }
                onClick={savePin}
              >
                Change PIN
              </button>
            </div>
          </>
        )}
        {pinMode === "disable" && (
          <>
            <div className="consent-box security-warning">
              <CircleAlert />
              <div>
                <strong>Remove the app privacy gate?</strong>
                <p>
                  The encrypted database remains protected by the signed-in
                  operating-system account, but Student Center will open without
                  asking for a PIN.
                </p>
              </div>
            </div>
            <label className="field">
              Current PIN
              <input
                type="password"
                autoFocus
                value={currentPin}
                onChange={(event) => setCurrentPin(event.target.value)}
                autoComplete="current-password"
              />
            </label>
            <div className="modal-actions">
              <button
                className="outline"
                onClick={() => {
                  resetPinFields();
                  setPinMode("home");
                }}
              >
                Keep app lock
              </button>
              <button
                className="solid danger-solid"
                disabled={busy || currentPin.length < 6}
                onClick={savePin}
              >
                Disable PIN
              </button>
            </div>
          </>
        )}
      </fieldset>
    </SettingsDetail>
  );
}
