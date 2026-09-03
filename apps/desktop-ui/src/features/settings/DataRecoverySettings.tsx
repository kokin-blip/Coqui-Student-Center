import { useEffect, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { SettingsDetail } from "../../components/SettingsDetail";
import {
  getDashboard,
  listLegacyQuarantine,
  purgeLegacyQuarantine,
  restoreLegacyQuarantine,
  type Dashboard,
  type LegacyQuarantineItem,
} from "../../native";

export function DataRecoverySettings({
  close,
  onDashboard,
  onToast,
}: {
  close: () => void;
  onDashboard: (data: Dashboard) => void;
  onToast: (message: string) => void;
}) {
  const [items, setItems] = useState<LegacyQuarantineItem[] | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    void listLegacyQuarantine()
      .then((value) => {
        if (active) setItems(value);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [reload]);
  const restore = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      await restoreLegacyQuarantine([id]);
      setItems((current) => current?.filter((item) => item.id !== id) ?? []);
      onToast("Legacy record restored to your local workspace.");
      try {
        onDashboard(await getDashboard());
      } catch {
        setError(
          "The record was restored, but the dashboard could not refresh. Reopen Today to retry.",
        );
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const purge = async () => {
    if (confirmation !== "PURGE LEGACY DATA") return;
    setBusy(true);
    setError("");
    try {
      await purgeLegacyQuarantine(confirmation);
      setItems([]);
      setConfirmation("");
      onToast("Legacy recovery snapshots permanently removed.");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsDetail
      title="Data recovery"
      subtitle="Legacy mock records are kept apart from your real plan until you choose to restore them."
      close={() => {
        if (!busy) close();
      }}
    >
      {error && (
        <div className="alert" role="alert">
          {error}
          <button
            disabled={busy}
            onClick={() => setReload((value) => value + 1)}
          >
            Reload recovery records
          </button>
        </div>
      )}
      {items === null ? (
        error ? null : (
          <p role="status">Loading local recovery records…</p>
        )
      ) : items.length ? (
        <>
          <div className="record-list compact">
            {items.map((item) => (
              <article key={item.id}>
                <div className="record-icon protected">
                  <RefreshCw />
                </div>
                <div>
                  <strong>{item.title}</strong>
                  <small>
                    {item.entityType} · quarantined{" "}
                    {new Intl.DateTimeFormat([], {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(item.quarantinedAt))}
                  </small>
                </div>
                <button
                  className="outline"
                  disabled={busy}
                  onClick={() => void restore(item.id)}
                >
                  Restore
                </button>
              </article>
            ))}
          </div>
          <div className="recovery-danger">
            <h2>Permanently remove recovery snapshots</h2>
            <p>This cannot be undone. Restored records are not affected.</p>
            <label className="field">
              Type PURGE LEGACY DATA to permanently remove recovery snapshots
              <input
                value={confirmation}
                disabled={busy}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
              />
            </label>
            <button
              className="solid danger-solid"
              disabled={busy || confirmation !== "PURGE LEGACY DATA"}
              onClick={() => void purge()}
            >
              Permanently purge snapshots
            </button>
          </div>
        </>
      ) : (
        <div className="empty-state">
          <ShieldCheck />
          <strong>No quarantined records</strong>
          <p>
            Fresh installations and completed cleanups have nothing to recover.
          </p>
        </div>
      )}
    </SettingsDetail>
  );
}
