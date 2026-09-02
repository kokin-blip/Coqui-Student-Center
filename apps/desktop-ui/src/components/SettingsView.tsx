import {
  Brain,
  CalendarDays,
  HardDrive,
  Link2,
  LockKeyhole,
  RefreshCw,
  UserRound,
} from "lucide-react";
import type { ReactNode } from "react";
import { AppearanceSettings } from "./AppearanceSettings";
import type { AccentPreference, AppearancePreference } from "./ThemeControls";

export type SettingsSection =
  | "canvas"
  | "ai"
  | "account"
  | "backups"
  | "security"
  | "notifications"
  | "updates"
  | "recovery";

type SettingsViewProps = {
  appearance: AppearancePreference;
  accent: AccentPreference;
  busy: boolean;
  institutionConfigured: boolean;
  onAppearance: (value: AppearancePreference) => void;
  onAccent: (value: AccentPreference) => void;
  onCanvas: () => void;
  onAi: () => void;
  onAccount: () => void;
  onBackups: () => void;
  onSecurity: () => void;
  onUpdates: () => void;
  onAcademic: () => void;
  onRecovery: () => void;
  onCalendarRefresh: () => void;
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
  appearance,
  accent,
  busy,
  institutionConfigured,
  onAppearance,
  onAccent,
  onCanvas,
  onAi,
  onAccount,
  onBackups,
  onSecurity,
  onUpdates,
  onAcademic,
  onRecovery,
  onCalendarRefresh,
}: SettingsViewProps) {
  return (
    <section
      className="content settings-page"
      data-route="settings"
      aria-labelledby="settings-title"
    >
      <div className="page-head">
        <div>
          <p className="eyebrow">Administrative controls</p>
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
              detail="Check the configured signed release channel"
              onClick={onUpdates}
            />
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
            theme={appearance}
            accent={accent}
            onTheme={onAppearance}
            onAccent={onAccent}
          />
        </section>
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
    <button className="settings-route-action" onClick={onClick}>
      <span aria-hidden="true">{icon}</span>
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
    </button>
  );
}
