import { useEffect, useState } from "react";
import {
  ChevronRight,
  CircleAlert,
  ExternalLink,
  HardDrive,
  Link2,
  LockKeyhole,
  LogOut,
  Mail,
  RefreshCw,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import {
  AccountStatus,
  approveSyncDevice,
  beginSyncProtection,
  cancelSyncProtection,
  checkExistingDeviceApproval,
  confirmSyncProtection,
  connectEncryptedSync,
  EncryptedSyncStatus,
  getEncryptedSyncStatus,
  getSyncProtectionStatus,
  listAuthorizedSyncDevices,
  listPendingSyncDevices,
  PendingSyncDevice,
  pullEncryptedMutations,
  pushEncryptedMutations,
  recoverSyncProtection,
  RecoverySetup,
  requestExistingDeviceApproval,
  revokeSyncDevice,
  SyncProtectionStatus,
} from "../native";
import { Modal } from "./Modal";

export function AccountModal({
  status,
  mode,
  email,
  code,
  retryAfter,
  busy,
  error,
  setEmail,
  setCode,
  clearError,
  close,
  changeEmail,
  useEmail,
  google,
  sendCode,
  verifyCode,
  refresh,
  signOut,
  presentation = "dialog",
}: {
  status: AccountStatus | null;
  mode: "email" | "verify";
  email: string;
  code: string;
  retryAfter: number;
  busy: boolean;
  error: string;
  setEmail: (value: string) => void;
  setCode: (value: string) => void;
  clearError: () => void;
  close: () => void;
  changeEmail: () => void;
  useEmail: () => void;
  google: () => void;
  sendCode: () => void;
  verifyCode: () => void;
  refresh: () => void;
  signOut: () => void;
  presentation?: "dialog" | "settings";
}) {
  const [syncStatus, setSyncStatus] = useState<SyncProtectionStatus | null>(
    null,
  );
  const [cloudSyncStatus, setCloudSyncStatus] =
    useState<EncryptedSyncStatus | null>(null);
  const [syncMode, setSyncMode] = useState<
    "home" | "words" | "confirm" | "recover" | "approval"
  >("home");
  const [recoverySetup, setRecoverySetup] = useState<RecoverySetup | null>(
    null,
  );
  const [recoveryConfirmations, setRecoveryConfirmations] = useState<
    Record<number, string>
  >({});
  const [recoveryPhrase, setRecoveryPhrase] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [pendingDevices, setPendingDevices] = useState<PendingSyncDevice[]>([]);
  const [authorizedDevices, setAuthorizedDevices] = useState<
    PendingSyncDevice[]
  >([]);
  useEffect(() => {
    let active = true;
    if (!status?.signedIn) {
      setSyncStatus(null);
      setCloudSyncStatus(null);
      return () => {
        active = false;
      };
    }
    Promise.all([getSyncProtectionStatus(), getEncryptedSyncStatus()])
      .then(([protection, cloud]) => {
        if (active) {
          setSyncStatus(protection);
          setCloudSyncStatus(cloud);
          if (cloud.connected) {
            void Promise.all([
              listPendingSyncDevices(),
              listAuthorizedSyncDevices(),
            ])
              .then(([pending, authorized]) => {
                if (active) {
                  setPendingDevices(pending);
                  setAuthorizedDevices(authorized);
                }
              })
              .catch(() => {
                if (active) {
                  setPendingDevices([]);
                  setAuthorizedDevices([]);
                }
              });
          }
        }
      })
      .catch((next) => {
        if (active) setSyncError(String(next));
      });
    return () => {
      active = false;
    };
  }, [status?.signedIn, status?.accountId]);
  const resetRecovery = () => {
    setSyncMode("home");
    setRecoverySetup(null);
    setRecoveryConfirmations({});
    setRecoveryPhrase("");
    setSyncError("");
  };
  const closeAccount = () => {
    if (busy || syncBusy) return;
    void cancelSyncProtection();
    resetRecovery();
    close();
  };
  const createRecovery = async () => {
    setSyncBusy(true);
    setSyncError("");
    try {
      const setup = await beginSyncProtection();
      setRecoverySetup(setup);
      setRecoveryConfirmations({});
      setSyncMode("words");
    } catch (next) {
      setSyncError(String(next));
    } finally {
      setSyncBusy(false);
    }
  };
  const confirmRecovery = async () => {
    if (!recoverySetup) return;
    setSyncBusy(true);
    setSyncError("");
    try {
      const confirmations = recoverySetup.confirmationPositions.map(
        (position) => ({
          position,
          word: recoveryConfirmations[position] ?? "",
        }),
      );
      setSyncStatus(await confirmSyncProtection(confirmations));
      setCloudSyncStatus(await getEncryptedSyncStatus());
      resetRecovery();
    } catch (next) {
      setSyncError(String(next));
    } finally {
      setSyncBusy(false);
    }
  };
  const restoreRecovery = async () => {
    setSyncBusy(true);
    setSyncError("");
    try {
      setSyncStatus(await recoverSyncProtection(recoveryPhrase));
      setCloudSyncStatus(await getEncryptedSyncStatus());
      resetRecovery();
    } catch (next) {
      setSyncError(String(next));
    } finally {
      setSyncBusy(false);
    }
  };
  const requestDeviceApproval = async () => {
    setSyncBusy(true);
    setSyncError("");
    try {
      await requestExistingDeviceApproval();
      setSyncMode("approval");
    } catch (next) {
      setSyncError(String(next));
    } finally {
      setSyncBusy(false);
    }
  };
  const checkDeviceApproval = async () => {
    setSyncBusy(true);
    setSyncError("");
    try {
      setSyncStatus(await checkExistingDeviceApproval());
      setCloudSyncStatus(await getEncryptedSyncStatus());
      resetRecovery();
    } catch (next) {
      setSyncError(String(next));
    } finally {
      setSyncBusy(false);
    }
  };
  const connectCloudSync = async () => {
    setSyncBusy(true);
    setSyncError("");
    try {
      setCloudSyncStatus(await connectEncryptedSync());
    } catch (next) {
      setSyncError(String(next));
    } finally {
      setSyncBusy(false);
    }
  };
  const pushCloudSync = async () => {
    setSyncBusy(true);
    setSyncError("");
    try {
      await pushEncryptedMutations();
      setCloudSyncStatus(await pullEncryptedMutations());
    } catch (next) {
      setSyncError(String(next));
    } finally {
      setSyncBusy(false);
    }
  };
  const approvePendingDevice = async (deviceId: string) => {
    setSyncBusy(true);
    setSyncError("");
    try {
      setPendingDevices(await approveSyncDevice(deviceId));
      setAuthorizedDevices(await listAuthorizedSyncDevices());
    } catch (next) {
      setSyncError(String(next));
    } finally {
      setSyncBusy(false);
    }
  };
  const revokeAuthorizedDevice = async (device: PendingSyncDevice) => {
    if (
      !window.confirm(
        `Revoke ${device.displayName}? It will immediately lose access to new encrypted changes and documents. It keeps whatever it already downloaded, so revoking does not undo past access.`,
      )
    )
      return;
    setSyncBusy(true);
    setSyncError("");
    try {
      const next = await revokeSyncDevice(device.deviceId);
      setCloudSyncStatus(next);
      if (next.connected)
        setAuthorizedDevices(await listAuthorizedSyncDevices());
      else setAuthorizedDevices([]);
    } catch (next) {
      setSyncError(String(next));
    } finally {
      setSyncBusy(false);
    }
  };
  const leaveRecovery = () => {
    void cancelSyncProtection();
    resetRecovery();
  };
  return (
    <Modal
      title="Optional Student Center account"
      subtitle="Your planner and encrypted local data never require an account or internet connection."
      close={closeAccount}
      presentation={presentation}
    >
      {error && (
        <div className="alert account-alert">
          <CircleAlert />
          <span>{error}</span>
          <button onClick={clearError} aria-label="Dismiss account error">
            <X />
          </button>
        </div>
      )}
      {!status ? (
        <div className="empty">Loading account security…</div>
      ) : !status.credentialAvailable ? (
        <div className="consent-box security-warning">
          <CircleAlert />
          <div>
            <strong>Credential vault unavailable</strong>
            <p>{status.message}</p>
          </div>
        </div>
      ) : !status.configured ? (
        <div className="update-state unconfigured">
          <UserRound />
          <span>
            <strong>No account service in this build</strong>
            <small>{status.message}</small>
          </span>
        </div>
      ) : status.signedIn ? (
        <>
          <div className="account-identity">
            <UserRound />
            <span>
              <strong>{status.email}</strong>
              <small>
                Account ID {status.accountId?.slice(0, 8)}… · Refresh token
                protected by the operating-system credential vault
              </small>
            </span>
            <b>{status.accessReady ? "Ready" : "Refresh needed"}</b>
          </div>
          {syncError && (
            <div className="alert account-alert">
              <CircleAlert />
              <span>{syncError}</span>
              <button onClick={() => setSyncError("")}>
                <X />
              </button>
            </div>
          )}
          {!syncStatus ? (
            <div className="empty">Checking recovery protection…</div>
          ) : syncStatus.protected ? (
            <>
              <div className="update-state current">
                <ShieldCheck />
                <span>
                  <strong>Recovery protected on this device</strong>
                  <small>
                    {syncStatus.message} Device{" "}
                    {syncStatus.deviceId?.slice(0, 8)}…
                  </small>
                </span>
              </div>
              <div className="consent-box">
                <LockKeyhole />
                <div>
                  <strong>Keys stay in the operating-system vault</strong>
                  <p>
                    The account key and this computer&apos;s X25519 private key
                    are never stored in SQLite or returned to the interface. A
                    separate Ed25519 identity signs device approvals. Mutation
                    content is encrypted locally before upload.
                  </p>
                </div>
              </div>
              {cloudSyncStatus && (
                <div
                  className={`update-state ${cloudSyncStatus.connected ? "current" : "unconfigured"}`}
                >
                  <RefreshCw />
                  <span>
                    <strong>
                      {cloudSyncStatus.connected
                        ? "Encrypted sync connected"
                        : cloudSyncStatus.configured
                          ? "Device registration required"
                          : "No sync service in this build"}
                    </strong>
                    <small>
                      {cloudSyncStatus.message}
                      {cloudSyncStatus.connected
                        ? ` ${cloudSyncStatus.pendingMutations} local change${cloudSyncStatus.pendingMutations === 1 ? "" : "s"} pending.`
                        : ""}
                    </small>
                  </span>
                </div>
              )}
              {!!cloudSyncStatus?.unsupportedDownloadedMutations && (
                <div className="consent-box">
                  <CircleAlert />
                  <div>
                    <strong>Changes from a newer version are waiting</strong>
                    <p>
                      Student Center saved{" "}
                      {cloudSyncStatus.unsupportedDownloadedMutations} encrypted
                      change
                      {cloudSyncStatus.unsupportedDownloadedMutations === 1
                        ? ""
                        : "s"}{" "}
                      that this version does not understand yet. They stay
                      encrypted on this computer and are applied automatically
                      after you update.
                    </p>
                  </div>
                </div>
              )}
              {cloudSyncStatus?.connected && pendingDevices.length > 0 && (
                <section
                  className="account-device-review"
                  aria-label="Pending devices"
                >
                  <h3>Devices awaiting approval</h3>
                  <p className="privacy-note">
                    Approve only a computer you recognize. The account key is
                    encrypted to that device and the envelope expires after 15
                    minutes.
                  </p>
                  {pendingDevices.map((device) => (
                    <div
                      className="update-state unconfigured"
                      key={device.deviceId}
                    >
                      <HardDrive />
                      <span>
                        <strong>{device.displayName}</strong>
                        <small>
                          {device.platform} · {device.deviceId.slice(0, 8)}…
                        </small>
                      </span>
                      <button
                        disabled={syncBusy}
                        onClick={() => approvePendingDevice(device.deviceId)}
                      >
                        Approve
                      </button>
                    </div>
                  ))}
                </section>
              )}
              {cloudSyncStatus?.connected && authorizedDevices.length > 0 && (
                <section
                  className="account-device-review"
                  aria-label="Authorized devices"
                >
                  <h3>Authorized devices</h3>
                  <p className="privacy-note">
                    Revoke a lost or retired computer to block new sync,
                    approval-envelope, and document access immediately.
                  </p>
                  {authorizedDevices.map((device) => {
                    const current =
                      device.deviceId === cloudSyncStatus.deviceId;
                    return (
                      <div
                        className="update-state configured"
                        key={device.deviceId}
                      >
                        <HardDrive />
                        <span>
                          <strong>
                            {device.displayName}
                            {current ? " · This device" : ""}
                          </strong>
                          <small>
                            {device.platform} · {device.deviceId.slice(0, 8)}…
                          </small>
                        </span>
                        <button
                          disabled={syncBusy}
                          onClick={() => revokeAuthorizedDevice(device)}
                        >
                          {current ? "Disconnect" : "Revoke"}
                        </button>
                      </div>
                    );
                  })}
                </section>
              )}
              {cloudSyncStatus?.connected && cloudSyncStatus.lastPushedAt && (
                <p className="privacy-note">
                  Last encrypted upload{" "}
                  {new Date(cloudSyncStatus.lastPushedAt).toLocaleString()}
                </p>
              )}
              <div className="modal-actions">
                {cloudSyncStatus?.connected ? (
                  <button
                    className="solid"
                    disabled={syncBusy}
                    onClick={pushCloudSync}
                  >
                    <RefreshCw />{" "}
                    {cloudSyncStatus.pendingMutations === 0
                      ? "Check encrypted sync"
                      : "Encrypt and sync now"}
                  </button>
                ) : (
                  <button
                    className="solid"
                    disabled={syncBusy || !cloudSyncStatus?.configured}
                    onClick={connectCloudSync}
                  >
                    <Link2 /> Register this device
                  </button>
                )}
              </div>
            </>
          ) : syncMode === "home" ? (
            <>
              <div className="consent-box">
                <ShieldCheck />
                <div>
                  <strong>Protect encrypted sync before connecting it</strong>
                  <p>
                    Create a one-time 24-word recovery code or enter the code
                    from another authorized computer. Losing every device and
                    this code makes synced data unrecoverable.
                  </p>
                </div>
              </div>
              <div className="backup-options">
                <button disabled={syncBusy} onClick={createRecovery}>
                  <LockKeyhole />
                  <span>
                    <strong>Create recovery code</strong>
                    <small>
                      Generate an account key and a separate device key locally.
                    </small>
                  </span>
                  <ChevronRight />
                </button>
                <button
                  disabled={syncBusy}
                  onClick={() => {
                    setSyncError("");
                    setSyncMode("recover");
                  }}
                >
                  <RefreshCw />
                  <span>
                    <strong>Use an existing code</strong>
                    <small>
                      Recover the account key and create a new key for this
                      computer.
                    </small>
                  </span>
                  <ChevronRight />
                </button>
                <button disabled={syncBusy} onClick={requestDeviceApproval}>
                  <HardDrive />
                  <span>
                    <strong>Ask an existing device</strong>
                    <small>
                      Approve this computer without typing the recovery code.
                    </small>
                  </span>
                  <ChevronRight />
                </button>
              </div>
            </>
          ) : syncMode === "words" && recoverySetup ? (
            <>
              <div className="consent-box security-warning">
                <CircleAlert />
                <div>
                  <strong>Write these words down now</strong>
                  <p>
                    Keep them offline and in order. Student Center will not
                    display them again after confirmation, and support cannot
                    recover them.
                  </p>
                </div>
              </div>
              <ol className="recovery-words">
                {recoverySetup.words.map((word, index) => (
                  <li key={`${index}-${word}`}>
                    <span>{index + 1}</span>
                    <strong>{word}</strong>
                  </li>
                ))}
              </ol>
              <div className="modal-actions">
                <button
                  className="outline"
                  disabled={syncBusy}
                  onClick={leaveRecovery}
                >
                  Cancel
                </button>
                <button
                  className="solid"
                  disabled={syncBusy}
                  onClick={() => setSyncMode("confirm")}
                >
                  I saved all 24 words
                </button>
              </div>
            </>
          ) : syncMode === "confirm" && recoverySetup ? (
            <>
              <div className="consent-box">
                <ShieldCheck />
                <div>
                  <strong>Confirm your written copy</strong>
                  <p>
                    Enter the requested words. The account key is saved to the
                    OS credential vault only after all three match.
                  </p>
                </div>
              </div>
              <div className="recovery-confirmations">
                {recoverySetup.confirmationPositions.map((position) => (
                  <label className="field" key={position}>
                    Word {position}
                    <input
                      autoFocus={
                        position === recoverySetup.confirmationPositions[0]
                      }
                      value={recoveryConfirmations[position] ?? ""}
                      onChange={(event) =>
                        setRecoveryConfirmations((current) => ({
                          ...current,
                          [position]: event.target.value,
                        }))
                      }
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                ))}
              </div>
              <div className="modal-actions">
                <button
                  className="outline"
                  disabled={syncBusy}
                  onClick={() => setSyncMode("words")}
                >
                  Back to words
                </button>
                <button
                  className="solid"
                  disabled={
                    syncBusy ||
                    recoverySetup.confirmationPositions.some(
                      (position) =>
                        !(recoveryConfirmations[position] ?? "").trim(),
                    )
                  }
                  onClick={confirmRecovery}
                >
                  Confirm and protect sync
                </button>
              </div>
            </>
          ) : syncMode === "recover" ? (
            <>
              <div className="consent-box">
                <RefreshCw />
                <div>
                  <strong>Recover on this computer</strong>
                  <p>
                    Enter all 24 words in order. Validation and key recovery
                    happen locally; the phrase is never sent to the account
                    service.
                  </p>
                </div>
              </div>
              <label className="field">
                24-word recovery code
                <textarea
                  autoFocus
                  value={recoveryPhrase}
                  onChange={(event) => setRecoveryPhrase(event.target.value)}
                  rows={5}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="word1 word2 word3 …"
                />
              </label>
              <div className="modal-actions">
                <button
                  className="outline"
                  disabled={syncBusy}
                  onClick={leaveRecovery}
                >
                  Back
                </button>
                <button
                  className="solid"
                  disabled={
                    syncBusy || recoveryPhrase.trim().split(/\s+/).length !== 24
                  }
                  onClick={restoreRecovery}
                >
                  Recover account key
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="consent-box security-warning">
                <HardDrive />
                <div>
                  <strong>Approval requested</strong>
                  <p>
                    On an already connected Student Center computer, open this
                    account panel and approve the pending device. The signed,
                    encrypted account-key envelope expires after 15 minutes.
                  </p>
                </div>
              </div>
              <div className="modal-actions">
                <button
                  className="outline"
                  disabled={syncBusy}
                  onClick={leaveRecovery}
                >
                  Back
                </button>
                <button
                  className="solid"
                  disabled={syncBusy}
                  onClick={checkDeviceApproval}
                >
                  <RefreshCw /> Check for approval
                </button>
              </div>
            </>
          )}
          {(syncStatus?.protected || syncMode === "home") && (
            <div className="modal-actions">
              <button
                className="outline danger"
                disabled={busy || syncBusy}
                onClick={signOut}
              >
                <LogOut /> Sign out on this computer
              </button>
              <button
                className="solid"
                disabled={busy || syncBusy || status.accessReady}
                onClick={refresh}
              >
                <RefreshCw /> Refresh session
              </button>
            </div>
          )}
        </>
      ) : status.googleSignInPending ? (
        <>
          <div className="account-browser-wait">
            <ExternalLink />
            <span>
              <strong>Finish in your system browser</strong>
              <small>{status.message}</small>
            </span>
          </div>
          <div className="consent-box">
            <ShieldCheck />
            <div>
              <strong>Native PKCE return</strong>
              <p>
                The browser receives no local student data. A one-time
                authorization code returns through the registered Student Center
                deep link and is exchanged only by the native app.
              </p>
            </div>
          </div>
          <div className="modal-actions">
            <button className="outline" disabled={busy} onClick={useEmail}>
              Use email code
            </button>
            <button className="solid" disabled={busy} onClick={google}>
              <ExternalLink /> Open Google again
            </button>
          </div>
        </>
      ) : mode === "email" ? (
        <>
          <button className="google-auth" disabled={busy} onClick={google}>
            <ExternalLink />
            <span>
              <strong>Continue with Google</strong>
              <small>
                Opens your system browser and returns securely to this app.
              </small>
            </span>
            <ChevronRight />
          </button>
          <div className="account-divider">
            <span>or use an email code</span>
          </div>
          <div className="consent-box">
            <Mail />
            <div>
              <strong>Email one-time code</strong>
              <p>
                Student Center asks Supabase to send a 6-digit code. The code is
                entered directly here and is never stored.
              </p>
            </div>
          </div>
          <label className="field">
            College or personal email
            <input
              type="email"
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              placeholder="alex@example.edu"
            />
          </label>
          <p className="privacy-note">
            <ShieldCheck /> Only the refresh token is persisted, inside the
            operating-system credential vault. Access tokens stay in
            native-process memory.
          </p>
          <div className="modal-actions">
            <button className="outline" onClick={close}>
              Not now
            </button>
            <button
              className="solid"
              disabled={busy || !email.includes("@") || retryAfter > 0}
              onClick={sendCode}
            >
              <Mail />{" "}
              {retryAfter > 0
                ? `Try again in ${retryAfter}s`
                : "Send sign-in code"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="account-code-destination">
            <Mail />
            <span>
              <strong>Check {email}</strong>
              <small>Enter the six digits from the Student Center email.</small>
            </span>
          </div>
          <label className="field">
            6-digit code
            <input
              className="otp-input"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              autoFocus
              value={code}
              onChange={(event) =>
                setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
              }
              autoComplete="one-time-code"
              placeholder="000000"
            />
          </label>
          <div className="modal-actions">
            <button className="outline" disabled={busy} onClick={changeEmail}>
              Change email
            </button>
            <button
              className="solid"
              disabled={busy || code.length !== 6}
              onClick={verifyCode}
            >
              Verify and sign in
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
