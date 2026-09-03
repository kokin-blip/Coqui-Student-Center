import { useState } from "react";
import { Link2, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import { SettingsDetail } from "../../components/SettingsDetail";
import {
  connectCanvas,
  connectCanvasCalendar,
  disconnectCanvas,
  disconnectCanvasCalendar,
  syncCanvas,
  refreshCanvasCalendar,
  setCanvasCalendarRefresh,
  type Dashboard,
} from "../../native";
export function CanvasSettings({
  data,
  close,
  onDashboard,
  onToast,
}: {
  data: Dashboard;
  close: () => void;
  onDashboard: (data: Dashboard) => void;
  onToast: (message: string) => void;
}) {
  const [canvasUrl, setCanvasUrl] = useState("");
  const [canvasToken, setCanvasToken] = useState("");
  const [canvasMode, setCanvasMode] = useState<"calendar" | "full">("calendar");
  const [canvasRefreshOnStartup, setCanvasRefreshOnStartup] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<Dashboard>, message: string) => {
    setBusy(true);
    setError("");
    try {
      const next = await action();
      onDashboard(next);
      onToast(next.importNotice ?? message);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsDetail
      title="Connect Canvas"
      subtitle="The calendar link is the fastest setup. Every imported fact remains pending until you review it."
      close={() => {
        if (!busy) close();
      }}
    >
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <fieldset className="settings-fields" disabled={busy}>
        <legend className="sr-only">Canvas connection settings</legend>
        <div className="connection-list">
          {data.canvasConnections.map((connection) => (
            <article className="connection" key={connection.id}>
              <div className="connection-head">
                <span>
                  <Link2 />
                  <strong>
                    {connection.accountName || connection.baseUrl}
                  </strong>
                  <small>
                    {connection.provider === "canvas_calendar"
                      ? "Calendar link · secret path hidden"
                      : "Canvas Full Connection"}{" "}
                    · {connection.baseUrl}
                  </small>
                </span>
                <b className={`status ${connection.status}`}>
                  {connection.status.replaceAll("_", " ")}
                </b>
              </div>
              <p>
                {connection.lastSyncedAt
                  ? `Last synced ${new Date(connection.lastSyncedAt).toLocaleString()}`
                  : "Not synced yet"}{" "}
                · {connection.pendingCandidates} pending
              </p>
              {connection.provider === "canvas_calendar" && (
                <small>
                  Automatic refresh {connection.refreshOnStartup ? "on" : "off"}
                  {connection.nextEligibleRefreshAt
                    ? ` · next eligible ${new Date(connection.nextEligibleRefreshAt).toLocaleString()}`
                    : ""}
                </small>
              )}
              {connection.lastError && <mark>{connection.lastError}</mark>}
              <div className="connection-actions">
                <button
                  className="outline"
                  disabled={
                    busy || !["connected", "error"].includes(connection.status)
                  }
                  onClick={() =>
                    run(
                      () =>
                        connection.provider === "canvas_calendar"
                          ? refreshCanvasCalendar(connection.id)
                          : syncCanvas(connection.id),
                      "Canvas refresh completed.",
                    )
                  }
                >
                  <RefreshCw /> Refresh
                </button>
                {connection.provider === "canvas_calendar" &&
                  connection.status !== "disconnected" && (
                    <button
                      className="outline"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () =>
                            setCanvasCalendarRefresh(
                              connection.id,
                              !connection.refreshOnStartup,
                            ),
                          `Automatic Canvas refresh ${connection.refreshOnStartup ? "disabled" : "enabled"}.`,
                        )
                      }
                    >
                      {connection.refreshOnStartup
                        ? "Turn auto refresh off"
                        : "Turn auto refresh on"}
                    </button>
                  )}
                <button
                  className="outline danger"
                  disabled={busy || connection.status === "disconnected"}
                  onClick={() =>
                    run(
                      () =>
                        connection.provider === "canvas_calendar"
                          ? disconnectCanvasCalendar(connection.id)
                          : disconnectCanvas(connection.id),
                      "Canvas disconnected.",
                    )
                  }
                >
                  <Unplug /> Disconnect
                </button>
              </div>
              <div className="sync-history">
                {data.canvasSyncRuns
                  .filter((run) => run.connectionId === connection.id)
                  .slice(0, 4)
                  .map((run) => (
                    <small key={run.id}>
                      <b>{run.status}</b>
                      <span>{new Date(run.startedAt).toLocaleString()}</span>
                      <span>{run.createdCount} changes</span>
                    </small>
                  ))}
              </div>
            </article>
          ))}
        </div>
        {!data.canvasConnections.some((connection) =>
          ["connected", "error"].includes(connection.status),
        ) && (
          <>
            <div
              className="segmented"
              role="group"
              aria-label="Canvas connection type"
            >
              <button
                className={canvasMode === "calendar" ? "active" : ""}
                onClick={() => setCanvasMode("calendar")}
              >
                Calendar link
              </button>
              <button
                className={canvasMode === "full" ? "active" : ""}
                onClick={() => setCanvasMode("full")}
              >
                Full connection · Advanced
              </button>
            </div>
            <label className="field">
              {canvasMode === "calendar"
                ? "Canvas calendar feed link"
                : "Canvas address"}
              <input
                value={canvasUrl}
                onChange={(event) => setCanvasUrl(event.target.value)}
                placeholder={
                  canvasMode === "calendar"
                    ? "https://canvas.yourcollege.edu/feeds/calendars/…ics"
                    : "https://canvas.yourcollege.edu"
                }
                autoComplete="off"
              />
            </label>
            {canvasMode === "full" && (
              <label className="field">
                Personal access token
                <input
                  type="password"
                  value={canvasToken}
                  onChange={(event) => setCanvasToken(event.target.value)}
                  placeholder="Stored only in the OS credential vault"
                  autoComplete="off"
                />
              </label>
            )}
            {canvasMode === "calendar" && (
              <>
                <p className="field-help">
                  In Canvas, open Calendar → Calendar Feed, copy the link, and
                  paste it here. Coqui stores the complete link only in your
                  operating system’s credential vault.
                </p>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={canvasRefreshOnStartup}
                    onChange={(event) =>
                      setCanvasRefreshOnStartup(event.target.checked)
                    }
                  />
                  <span>
                    Refresh automatically after unlock when at least 24 hours
                    have passed
                  </span>
                </label>
              </>
            )}
            <div className="consent-box">
              <ShieldCheck />
              <div>
                <strong>Read-only and local</strong>
                <p>
                  Coqui validates every HTTPS destination, blocks private
                  networks, and never writes to Canvas. The secret link or token
                  is never stored in the SQL database or returned here.
                </p>
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="solid"
                disabled={
                  busy ||
                  !canvasUrl.trim() ||
                  (canvasMode === "full" && canvasToken.length < 16)
                }
                onClick={() => {
                  const submittedUrl = canvasUrl.trim();
                  const submittedToken = canvasToken;
                  setCanvasUrl("");
                  setCanvasToken("");
                  void run(
                    () =>
                      canvasMode === "calendar"
                        ? connectCanvasCalendar(
                            submittedUrl,
                            "Canvas calendar",
                            canvasRefreshOnStartup,
                          )
                        : connectCanvas(submittedUrl, submittedToken),
                    "Canvas connected; review the imported facts.",
                  );
                }}
              >
                Validate and connect
              </button>
            </div>
          </>
        )}
      </fieldset>
    </SettingsDetail>
  );
}
