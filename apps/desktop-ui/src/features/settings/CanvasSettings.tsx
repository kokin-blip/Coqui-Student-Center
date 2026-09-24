import { useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  ExternalLink,
  HelpCircle,
  Link2,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from "lucide-react";
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

const CANVAS_CALENDAR_GUIDE =
  "https://community.instructure.com/en/kb/articles/662804-unknown";
const CANVAS_TOKEN_GUIDE =
  "https://community.instructure.com/en/kb/articles/662901-how-do-i-manage-api-access-tokens-in-my-user-account";

function CanvasCalendarGuide() {
  return (
    <section className="canvas-guide" aria-labelledby="canvas-guide-title">
      <div className="canvas-guide-heading">
        <div>
          <h2 id="canvas-guide-title">Find your Calendar Feed</h2>
          <p>Usually takes about a minute in the Canvas desktop website.</p>
        </div>
        <a href={CANVAS_CALENDAR_GUIDE} target="_blank" rel="noreferrer">
          Official screenshots <ExternalLink />
        </a>
      </div>
      <ol className="canvas-guide-steps">
        <li>
          <CalendarDays aria-hidden="true" />
          <div><strong>Open Calendar</strong><span>Use Calendar in Canvas’s global navigation.</span></div>
          <div className="canvas-guide-shot canvas-guide-shot--navigation"><img src="/guides/canvas-calendar/v1/open-calendar.png" alt="Canvas global navigation with Calendar outlined" loading="lazy" decoding="async" /></div>
        </li>
        <li>
          <Link2 aria-hidden="true" />
          <div><strong>Choose Calendar Feed</strong><span>It appears in the Calendar sidebar on the desktop website.</span></div>
          <div className="canvas-guide-shot canvas-guide-shot--sidebar"><img src="/guides/canvas-calendar/v1/calendar-feed.png" alt="Canvas Calendar sidebar with the Calendar Feed link outlined" loading="lazy" decoding="async" /></div>
        </li>
        <li>
          <Copy aria-hidden="true" />
          <div><strong>Copy the entire URL</strong><span>Copy the URL field from the feed window, then return here.</span></div>
          <div className="canvas-guide-shot canvas-guide-shot--dialog"><img src="/guides/canvas-calendar/v1/copy-feed-url.png" alt="Canvas Calendar Feed window with an example URL outlined and redacted" loading="lazy" decoding="async" /></div>
        </li>
      </ol>
      <p className="canvas-guide-version">
        Adapted from official Canvas LMS screenshots, redacted for this guide · v1, source checked September 22, 2026. Placement may vary by school.
      </p>
    </section>
  );
}
export function CanvasSettings({
  data,
  close,
  onDashboard,
  onToast,
  onReview,
}: {
  data: Dashboard;
  close: () => void;
  onDashboard: (data: Dashboard) => void;
  onToast: (message: string) => void;
  onReview: (connectionId: string) => void;
}) {
  const [canvasUrl, setCanvasUrl] = useState("");
  const [canvasToken, setCanvasToken] = useState("");
  const [canvasMode, setCanvasMode] = useState<"calendar" | "full">("calendar");
  const [canvasRefreshOnStartup, setCanvasRefreshOnStartup] = useState(true);
  const [institutionApprovedToken, setInstitutionApprovedToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<Dashboard>, message: string) => {
    setBusy(true);
    setError("");
    try {
      const next = await action();
      onDashboard(next);
      onToast(next.importNotice ?? message);
      return next;
    } catch (reason) {
      setError(String(reason));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const connect = async () => {
    const submittedUrl = canvasUrl.trim();
    const submittedToken = canvasToken;
    const existingIds = new Set(
      data.canvasConnections.map((connection) => connection.id),
    );
    setCanvasUrl("");
    setCanvasToken("");
    const next = await run(
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
    if (!next) return;
    const connected = next.canvasConnections.find(
      (connection) => !existingIds.has(connection.id),
    );
    if (connected?.pendingCandidates) onReview(connected.id);
    else onToast("Canvas connected. No new items to review.");
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
              <dl className="connection-health" aria-label="Connection health">
                <div>
                  <dt>Last successful check</dt>
                  <dd>{connection.lastSyncedAt ? new Date(connection.lastSyncedAt).toLocaleString() : "Not checked yet"}</dd>
                </div>
                <div>
                  <dt>Waiting for review</dt>
                  <dd>{connection.pendingCandidates} item{connection.pendingCandidates === 1 ? "" : "s"}</dd>
                </div>
                <div>
                  <dt>Automatic refresh</dt>
                  <dd>{connection.provider === "canvas_calendar" ? (connection.refreshOnStartup ? "On" : "Off") : "Manual"}</dd>
                </div>
                {connection.nextEligibleRefreshAt && (
                  <div>
                    <dt>Next eligible refresh</dt>
                    <dd>{new Date(connection.nextEligibleRefreshAt).toLocaleString()}</dd>
                  </div>
                )}
              </dl>
              {connection.lastError && (
                <div className="connection-error" role="status">
                  <AlertTriangle aria-hidden="true" />
                  <span><strong>Last refresh needs attention</strong>{connection.lastError}</span>
                </div>
              )}
              <div className="connection-actions">
                {connection.pendingCandidates > 0 && (
                  <button
                    className="solid"
                    disabled={busy}
                    onClick={() => onReview(connection.id)}
                  >
                    <ClipboardCheck /> Review {connection.pendingCandidates}{" "}
                    pending
                  </button>
                )}
                <button
                  className="outline"
                  disabled={
                    busy || !["connected", "error"].includes(connection.status)
                  }
                  onClick={() => {
                    void (async () => {
                      const next = await run(
                        () =>
                          connection.provider === "canvas_calendar"
                            ? refreshCanvasCalendar(connection.id)
                            : syncCanvas(connection.id),
                        "Canvas refresh completed.",
                      );
                      if (!next) return;
                      const refreshed = next.canvasConnections.find(
                        (item) => item.id === connection.id,
                      );
                      if (refreshed?.pendingCandidates) onReview(connection.id);
                      else
                        onToast(
                          "Canvas is up to date. No new items to review.",
                        );
                    })();
                  }}
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
              {connection.status !== "disconnected" && (
                <p className="disconnect-note">
                  Disconnecting stops future refreshes and removes the saved local credential. Assignments and events you already approved stay in Coqui.
                </p>
              )}
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
            <CanvasCalendarGuide />
            <section className="canvas-connect-form" aria-labelledby="canvas-feed-form-title">
              <div className="canvas-connect-heading">
                <div>
                  <h2 id="canvas-feed-form-title">Paste the feed link</h2>
                  <p>Coqui checks the link, imports proposed facts, and opens review before anything becomes part of your plan.</p>
                </div>
                <span><CheckCircle2 aria-hidden="true" /> Recommended</span>
              </div>
              <label className="field">
                Canvas calendar feed link
                <input
                  value={canvasMode === "calendar" ? canvasUrl : ""}
                  onFocus={() => setCanvasMode("calendar")}
                  onChange={(event) => {
                    setCanvasMode("calendar");
                    setCanvasUrl(event.target.value);
                  }}
                  placeholder="https://canvas.yourcollege.edu/feeds/calendars/…"
                  autoComplete="off"
                  inputMode="url"
                />
              </label>
              <p className="field-help">
                Treat this private URL like a password. The Canvas feed includes calendar events and assignments, but not Canvas To Do items.
              </p>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={canvasRefreshOnStartup}
                  onChange={(event) => setCanvasRefreshOnStartup(event.target.checked)}
                />
                <span>Refresh after unlock when at least 24 hours have passed</span>
              </label>
              <button
                className="solid canvas-connect-action"
                disabled={busy || canvasMode !== "calendar" || !canvasUrl.trim()}
                onClick={() => void connect()}
              >
                Validate feed and connect
              </button>
            </section>
            <div className="consent-box">
              <ShieldCheck />
              <div>
                <strong>Read-only and local</strong>
                <p>
                  Coqui validates every HTTPS destination, blocks private
                  networks, and never writes to Canvas. The complete feed link
                  is kept in your operating system’s credential vault, not the SQL database.
                </p>
              </div>
            </div>
            <details className="canvas-troubleshooting">
              <summary><HelpCircle aria-hidden="true" /> Calendar Feed missing or not working?</summary>
              <div>
                <p><strong>No Calendar Feed link:</strong> use Canvas in a desktop browser and check the Calendar sidebar. If it is still absent, your school may have changed or restricted this feature.</p>
                <p><strong>A new course is missing:</strong> Canvas’s guide says newly enrolled course calendars may require the feed to be imported again. Disconnect, then reconnect with the current feed URL.</p>
                <p><strong>To Do items are missing:</strong> Canvas does not include them in the iCal feed. Import a schedule file or add those tasks manually.</p>
                <p><strong>Validation fails:</strong> copy the entire URL from the Calendar Feed window—not the address shown in your browser’s location bar.</p>
              </div>
            </details>
            <details
              className="canvas-advanced"
              onToggle={(event) => {
                const open = event.currentTarget.open;
                setCanvasMode(open ? "full" : "calendar");
                setCanvasUrl("");
                setCanvasToken("");
                setInstitutionApprovedToken(false);
              }}
            >
              <summary>Advanced: institution-approved API access</summary>
              <div className="canvas-advanced-content">
                <div className="connection-error policy-warning">
                  <AlertTriangle aria-hidden="true" />
                  <span>
                    <strong>Do not create a personal token solely for Coqui</strong>
                    Canvas’s current policy says applications must use approved authentication. Continue only if your school issued or explicitly approved this credential.
                  </span>
                </div>
                <a href={CANVAS_TOKEN_GUIDE} target="_blank" rel="noreferrer">
                  Review Canvas token guidance <ExternalLink />
                </a>
                <label className="field">
                  Canvas address
                  <input
                    value={canvasMode === "full" ? canvasUrl : ""}
                    onChange={(event) => setCanvasUrl(event.target.value)}
                    placeholder="https://canvas.yourcollege.edu"
                    autoComplete="off"
                    inputMode="url"
                  />
                </label>
                <label className="field">
                  Institution-approved access token
                  <input
                    type="password"
                    value={canvasToken}
                    onChange={(event) => setCanvasToken(event.target.value)}
                    placeholder="Stored only in the OS credential vault"
                    autoComplete="off"
                  />
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={institutionApprovedToken}
                    onChange={(event) => setInstitutionApprovedToken(event.target.checked)}
                  />
                  <span>My institution issued or explicitly approved this token for Coqui</span>
                </label>
                <button
                  className="solid canvas-connect-action"
                  disabled={busy || canvasMode !== "full" || !canvasUrl.trim() || canvasToken.length < 16 || !institutionApprovedToken}
                  onClick={() => void connect()}
                >
                  Validate approved connection
                </button>
              </div>
            </details>
          </>
        )}
      </fieldset>
    </SettingsDetail>
  );
}
