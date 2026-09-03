import { useState } from "react";
import { Check, Play, ShieldCheck } from "lucide-react";
import { SettingsDetail } from "../../components/SettingsDetail";
import {
  dismissReminder,
  isDesktop,
  snoozeReminder,
  startPlanBlock,
  toggleTask,
  updateNotificationSettings,
  type Dashboard,
} from "../../native";

export function NotificationsSettings({
  data,
  onDashboard,
  onToast,
  close,
}: {
  data: Dashboard;
  onDashboard: (data: Dashboard) => void;
  onToast: (message: string) => void;
  close: () => void;
}) {
  const [form, setForm] = useState(data.notificationSettings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reminders = data.blocks
    .filter((block) => block.taskId && !block.completed)
    .slice(0, 4);
  const run = async (action: () => Promise<Dashboard>, success: string) => {
    setBusy(true);
    setError("");
    try {
      onDashboard(await action());
      onToast(success);
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    const saved = await run(
      () =>
        updateNotificationSettings(
          form.enabled,
          form.leadMinutes,
          form.quietStart,
          form.quietEnd,
          form.showTitles,
        ),
      form.enabled
        ? "Private desktop reminders enabled."
        : "Desktop reminders disabled.",
    );
    if (saved) close();
  };
  return (
    <SettingsDetail
      title="Desktop reminders"
      subtitle="Choose when Coqui may alert you. You can also act on reminders here."
      close={() => {
        if (!busy) close();
      }}
    >
      {error && (
        <p className="alert" role="alert">
          {error} Your settings have not been discarded.
        </p>
      )}
      {!isDesktop() && (
        <p className="field-help">
          Reminder delivery and saving are available in the installed desktop
          app.
        </p>
      )}
      <fieldset className="settings-fields" disabled={busy}>
        <legend className="sr-only">Reminder preferences</legend>
        <label className="setting-toggle">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                enabled: event.target.checked,
              }))
            }
          />
          <span>
            <strong>Allow native reminders</strong>
            <small>
              Uses your operating system’s notification center. Core planning
              works offline.
            </small>
          </span>
        </label>
        <div className="notification-grid">
          <label className="field">
            Remind me before a block
            <input
              type="number"
              min={1}
              max={120}
              value={form.leadMinutes}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  leadMinutes: Number(event.target.value),
                }))
              }
            />
            <small>Minutes</small>
          </label>
          <label className="field">
            Quiet hours begin
            <input
              type="time"
              value={form.quietStart}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  quietStart: event.target.value,
                }))
              }
            />
          </label>
          <label className="field">
            Quiet hours end
            <input
              type="time"
              value={form.quietEnd}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  quietEnd: event.target.value,
                }))
              }
            />
          </label>
        </div>
        <label className="setting-toggle compact">
          <input
            type="checkbox"
            checked={form.showTitles}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                showTitles: event.target.checked,
              }))
            }
          />
          <span>
            <strong>Show task titles in notifications</strong>
            <small>
              Off by default to keep academic details off the lock screen.
              Locked-app reminders are always generic.
            </small>
          </span>
        </label>
        <div className="reminder-list">
          <div className="small-head">
            <h2>Upcoming reminder controls</h2>
            <span>{reminders.length}</span>
          </div>
          {reminders.length ? (
            reminders.map((block) => (
              <article className="reminder-item" key={block.id}>
                <div>
                  <strong>{block.title}</strong>
                  <small>
                    {new Intl.DateTimeFormat([], {
                      hour: "numeric",
                      minute: "2-digit",
                      timeZone: data.timezone,
                    }).format(new Date(block.startsAt))}{" "}
                    ·{" "}
                    {Math.max(
                      0,
                      Math.round(
                        (Date.parse(block.endsAt) -
                          Date.parse(block.startsAt)) /
                          60000,
                      ),
                    )}{" "}
                    min{block.startedAt ? " · In progress" : ""}
                  </small>
                </div>
                <div>
                  <button
                    className="outline"
                    disabled={!isDesktop()}
                    onClick={() =>
                      void run(
                        () => startPlanBlock(block.id),
                        "Focus session started.",
                      )
                    }
                  >
                    <Play /> Start
                  </button>
                  <button
                    className="outline"
                    disabled={!isDesktop()}
                    onClick={() =>
                      void run(
                        () => snoozeReminder(block.id, 10),
                        "Reminder snoozed for 10 minutes.",
                      )
                    }
                  >
                    Snooze
                  </button>
                  <button
                    className="outline"
                    disabled={!isDesktop()}
                    onClick={() =>
                      void run(
                        () => toggleTask(block.taskId!),
                        "Block completed.",
                      )
                    }
                  >
                    <Check /> Complete
                  </button>
                  <button
                    className="text-button"
                    disabled={!isDesktop()}
                    onClick={() =>
                      void run(
                        () => dismissReminder(block.id),
                        "Reminder dismissed.",
                      )
                    }
                  >
                    Dismiss
                  </button>
                </div>
              </article>
            ))
          ) : (
            <p className="section-empty-copy">
              No unfinished task blocks are scheduled today.
            </p>
          )}
        </div>
        <p className="privacy-note">
          <ShieldCheck /> Reminder settings and delivery history stay in the
          encrypted local database.
        </p>
        <div className="modal-actions">
          <button className="outline" onClick={close}>
            Cancel
          </button>
          <button
            className="solid"
            disabled={
              !isDesktop() ||
              !Number.isInteger(form.leadMinutes) ||
              form.leadMinutes < 1 ||
              form.leadMinutes > 120 ||
              !form.quietStart ||
              !form.quietEnd
            }
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save reminder settings"}
          </button>
        </div>
      </fieldset>
    </SettingsDetail>
  );
}
