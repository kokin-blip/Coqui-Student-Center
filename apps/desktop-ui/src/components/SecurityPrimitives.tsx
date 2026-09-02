import { useState } from "react";
import { CircleAlert, ShieldCheck } from "lucide-react";
import type { BackupPreview, SecurityStatus } from "../native";
import { AppLogo } from "./AppLogo";

const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function LockScreen({
  security,
  unlock,
}: {
  security: SecurityStatus;
  unlock: (pin: string) => Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await unlock(pin);
      setPin("");
    } catch (e) {
      setPin("");
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="lock-screen">
      <section className="lock-card" aria-labelledby="lock-title">
        <AppLogo className="brand-mark" />
        <p className="eyebrow">Private local workspace</p>
        <h1 id="lock-title">Student Center is locked</h1>
        <p>
          Your plan, documents, and connected services stay unavailable until
          you enter your PIN.
        </p>
        <form onSubmit={submit}>
          <label className="field">
            Student Center PIN
            <input
              type="password"
              autoFocus
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              autoComplete="current-password"
              disabled={busy || security.retryAfterSeconds > 0}
            />
          </label>
          {error && (
            <div className="alert" role="alert">
              <CircleAlert />
              <span>{error}</span>
            </div>
          )}
          <button
            className="solid unlock-button"
            disabled={busy || pin.length < 6 || security.retryAfterSeconds > 0}
          >
            {busy
              ? "Checking…"
              : security.retryAfterSeconds > 0
                ? `Try again in ${security.retryAfterSeconds}s`
                : "Unlock Student Center"}
          </button>
        </form>
        <div className="lock-foot">
          <ShieldCheck />
          <span>
            <strong>Encrypted on this device</strong>
            <small>The PIN never leaves this computer.</small>
          </span>
        </div>
      </section>
    </main>
  );
}

export function BackupSummary({
  preview,
  title,
}: {
  preview: BackupPreview;
  title: string;
}) {
  return (
    <section className="backup-summary">
      <div>
        <ShieldCheck />
        <span>
          <strong>{title}</strong>
          <small>SHA-256 {preview.fingerprint.slice(0, 16)}…</small>
        </span>
      </div>
      <dl>
        <div>
          <dt>{preview.studentName}</dt>
          <dd>Profile</dd>
        </div>
        <div>
          <dt>{new Date(preview.createdAt).toLocaleString()}</dt>
          <dd>Created</dd>
        </div>
        <div>
          <dt>{preview.counts.tasks}</dt>
          <dd>Tasks</dd>
        </div>
        <div>
          <dt>{preview.counts.documents}</dt>
          <dd>Sources</dd>
        </div>
        <div>
          <dt>{formatBytes(preview.encryptedBytes)}</dt>
          <dd>Encrypted size</dd>
        </div>
        <div>
          <dt>v{preview.appVersion}</dt>
          <dd>App version</dd>
        </div>
      </dl>
    </section>
  );
}
