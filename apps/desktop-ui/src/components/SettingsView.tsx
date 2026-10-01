import {
  Brain,
  Bell,
  CalendarDays,
  HardDrive,
  Link2,
  LockKeyhole,
  RefreshCw,
  Sparkles,
  UserRound,
  Upload,
} from "lucide-react";
import { type ReactNode } from "react";
import type { InterfaceMode } from "../features/shell/interfacePreferences";
import { AppearanceSettings } from "./AppearanceSettings";
import type { AccentPreference, AppearancePreference } from "./ThemeControls";
import "../features/settings/settings.css";
import type { DelightPreferences } from "../features/shell/delightPreferences";

export type SettingsSection =
  | "academic"
  | "canvas"
  | "brightspace"
  | "ai"
  | "account"
  | "backups"
  | "security"
  | "notifications"
  | "updates"
  | "recovery";

type SettingsViewProps = {
  interfaceMode?: InterfaceMode;
  onInterfaceMode?: (mode: InterfaceMode) => void;
  onDeleteProfile?: () => void;
  appearance: AppearancePreference;
  accent: AccentPreference;
  busy: boolean;
  institutionConfigured: boolean;
  onAppearance: (value: AppearancePreference) => void;
  onAccent: (value: AccentPreference) => void;
  onCanvas: () => void;
  onBrightspace?: () => void;
  onAi: () => void;
  onAccount: () => void;
  onBackups: () => void;
  onSecurity: () => void;
  onUpdates: () => void;
  onNotifications: () => void;
  onAcademic: () => void;
  onRecovery: () => void;
  onCalendarRefresh: () => void;
  delight: DelightPreferences;
  onDelightChange: (next: DelightPreferences) => void;
};

const sections = [
  {
    title: "Integrations",
    description: "Connect academic sources and your own AI providers.",
  },
  {
    title: "Data and security",
    description: "Control encrypted sync, backups, locking, and recovery.",
  },
  {
    title: "Application",
    description: "Manage academic defaults, updates, and appearance.",
  },
] as const;

export function SettingsView({
  interfaceMode,
  onInterfaceMode,
  onDeleteProfile,
  appearance,
  accent,
  busy,
  institutionConfigured,
  onAppearance,
  onAccent,
  onCanvas,
  onBrightspace,
  onAi,
  onAccount,
  onBackups,
  onSecurity,
  onUpdates,
  onNotifications,
  onAcademic,
  onRecovery,
  onCalendarRefresh,
  delight,
  onDelightChange,
}: SettingsViewProps) {
  const updateDelight=(patch:Partial<DelightPreferences>)=>onDelightChange({...delight,...patch});
  return (
    <section
      className="content settings-page"
      data-route="settings"
      aria-labelledby="settings-title"
    >
      <div className="page-head">
        <div>
          <h1 id="settings-title">Settings</h1>
          <p>
            Configure the workspace without leaving the task you were doing.
            Changes remain local unless a control explicitly says otherwise.
          </p>
        </div>
      </div>

      <div className="settings-route-grid">
        <section className="workspace-panel settings-route-section">
          <header>
            <h2>{sections[0].title}</h2>
            <p>{sections[0].description}</p>
          </header>
          <div className="settings-route-list">
            <SettingsAction
              icon={<Link2 />}
              title="Canvas"
              detail="Calendar-link and full read-only connections"
              onClick={onCanvas}
            />
            <SettingsAction icon={<Upload />} title="Brightspace" detail="Downloaded calendars and academic documents" onClick={onBrightspace ?? (() => {})} />
            <SettingsAction
              icon={<Brain />}
              title="AI providers"
              detail="OpenAI, Anthropic, and Gemini bring-your-own-key settings"
              onClick={onAi}
            />
          </div>
        </section>

        <section className="workspace-panel settings-route-section">
          <header>
            <h2>{sections[1].title}</h2>
            <p>{sections[1].description}</p>
          </header>
          <div className="settings-route-list">
            <SettingsAction
              icon={<UserRound />}
              title="Account & sync"
              detail="Optional account and end-to-end encrypted device sync"
              onClick={onAccount}
            />
            <SettingsAction
              icon={<HardDrive />}
              title="Backup & recovery"
              detail="Portable encrypted archives and restore previews"
              onClick={onBackups}
            />
            <SettingsAction
              icon={<LockKeyhole />}
              title="Privacy & security"
              detail="App lock, notification privacy, and local credentials"
              onClick={onSecurity}
            />
            <SettingsAction
              icon={<RefreshCw />}
              title="Advanced data recovery"
              detail="Inspect and recover quarantined legacy records"
              onClick={onRecovery}
            />
          </div>
        </section>

        <section className="workspace-panel settings-route-section">
          <header>
            <h2>{sections[2].title}</h2>
            <p>{sections[2].description}</p>
          </header>
          <div className="settings-route-list">
            <SettingsAction
              icon={<CalendarDays />}
              title="Academic & planning"
              detail="Terms, profile, availability, and safe cleanup"
              onClick={onAcademic}
            />
            <SettingsAction
              icon={<RefreshCw />}
              title="Updates"
              detail="Installed version and update availability"
              onClick={onUpdates}
            />
            <SettingsAction
              icon={<Bell />}
              title="Notifications"
              detail="Reminder timing, quiet hours, and title privacy"
              onClick={onNotifications}
            />
            <div className="settings-delight">
              <div><Sparkles /><span><strong>Sounds & celebrations</strong><small>Supportive feedback, stored on this device</small></span></div>
              <label><input type="checkbox" checked={delight.celebrations} onChange={(event)=>updateDelight({celebrations:event.target.checked})}/>Visual celebrations</label>
              <label><input type="checkbox" checked={delight.completionSounds} onChange={(event)=>updateDelight({completionSounds:event.target.checked})}/>Completion sounds</label>
              <label><input type="checkbox" checked={delight.interfaceSounds} onChange={(event)=>updateDelight({interfaceSounds:event.target.checked})}/>Navigation sounds</label>
              <label><input type="checkbox" checked={delight.reminderSounds} onChange={(event)=>updateDelight({reminderSounds:event.target.checked})}/>Reminder notification sounds</label>
              <label><input type="checkbox" checked={delight.momentumDisplay} onChange={(event)=>updateDelight({momentumDisplay:event.target.checked})}/>Momentum display</label>
              <label>Weekly task goal (0 turns off)<input className="weekly-goal-input" type="number" min="0" max="20" step="1" value={delight.weeklyGoalTasks} onChange={(event)=>updateDelight({weeklyGoalTasks:Math.max(0,Math.min(20,Math.floor(Number(event.target.value)||0)))})}/></label>
              <small>Counts tasks completed Monday–Sunday in your profile’s timezone. Reach your goal for one celebration; missed weeks do not reduce anything.</small>
              <label>In-app volume<input type="range" min="0" max="1" step="0.05" value={delight.volume} onChange={(event)=>updateDelight({volume:Number(event.target.value)})}/></label>
              <small>Reminder sounds follow your system volume and Do Not Disturb settings.</small>
            </div>
          </div>
          <div className="settings-calendar-refresh">
            <div>
              <strong>Your school’s calendar</strong>
              <p>
                Review registrar term-date and holiday changes before applying
                them. Student-edited dates are never overwritten.
              </p>
            </div>
            <button
              className="outline"
              disabled={busy || !institutionConfigured}
              onClick={onCalendarRefresh}
            >
              Check for calendar updates
            </button>
            {!institutionConfigured && (
              <small className="source-note">
                Add your school first, or maintain academic dates manually.
              </small>
            )}
          </div>
        </section>

        <section className="workspace-panel settings-route-section appearance-route-section">
          <header>
            <h2>Appearance</h2>
            <p>Theme and density apply immediately and remain accessible.</p>
          </header>
          <AppearanceSettings
            interfaceMode={interfaceMode}
            onInterfaceMode={onInterfaceMode}
            theme={appearance}
            accent={accent}
            onTheme={onAppearance}
            onAccent={onAccent}
          />
        </section>
        <section className="workspace-panel settings-route-section">
          <h2>Student workflow help</h2>
          <details><summary>Check-in, notes, and assignment streak</summary>
            <p>Enable daily check-in in Notifications. Review planned or due tasks yourself, snooze or dismiss the day, and confirm deadline changes in Work. Check-ins use your saved timezone and quiet hours.</p>
            <p>Quick notes capture short thoughts locally. For longer notes, open Study → Materials to write, tag, search, and link source materials. Templates work offline. AI requests disclose the exact source text, provider, and model before fresh consent; review and save the draft explicitly.</p>
            <p>The assignment streak uses recorded completion times and scoring deadlines. Deadline edits after completion or an elapsed deadline keep the original scoring deadline. Open the Today explanation to inspect outcomes and history, or hide the streak in Notifications.</p>
          </details>
        </section>
        {onDeleteProfile && (
          <section className="workspace-panel settings-route-section">
            <header>
              <h2>Delete local profile</h2>
              <p>
                Remove this device's local records only after confirmation.
                Export a backup first.
              </p>
            </header>
            <button className="outline danger" onClick={onDeleteProfile}>
              Delete local profile
            </button>
          </section>
        )}
      </div>
    </section>
  );
}

function SettingsAction({
  icon,
  title,
  detail,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      className="settings-route-action"
      data-settings-action={title}
      onClick={onClick}
    >
      <span aria-hidden="true">{icon}</span>
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
    </button>
  );
}
