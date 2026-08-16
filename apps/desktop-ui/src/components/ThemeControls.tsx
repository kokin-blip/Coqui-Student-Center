import { Monitor, Moon, Sun } from "lucide-react";

/** A theme the user can pick. "system" follows the OS. */
export type AppearancePreference =
  | "system"
  | "coqui-dark"
  | "midnight"
  | "graphite"
  | "forest"
  | "light";

export type AccentPreference =
  | "green"
  | "mint"
  | "blue"
  | "purple"
  | "rose"
  | "amber";

export const THEMES: { value: AppearancePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "coqui-dark", label: "Coqui Dark" },
  { value: "midnight", label: "Midnight" },
  { value: "graphite", label: "Graphite" },
  { value: "forest", label: "Forest" },
  { value: "light", label: "Light" },
];

export const ACCENTS: { value: AccentPreference; label: string }[] = [
  { value: "green", label: "Coqui Green" },
  { value: "mint", label: "Mint" },
  { value: "blue", label: "Blue" },
  { value: "purple", label: "Purple" },
  { value: "rose", label: "Rose" },
  { value: "amber", label: "Amber" },
];

const THEME_VALUES = THEMES.map((theme) => theme.value);
const ACCENT_VALUES = ACCENTS.map((accent) => accent.value);

const THEME_KEY = "student-center-appearance";
const ACCENT_KEY = "student-center-accent";

const prefersDark = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-color-scheme: dark)").matches;

/**
 * "system" is resolved here rather than mirrored into a prefers-color-scheme
 * block, so each theme is defined exactly once in tokens.css.
 */
export function resolveTheme(preference: AppearancePreference) {
  if (preference !== "system") return preference;
  return prefersDark() ? "coqui-dark" : "light";
}

export function applyAppearance(
  preference: AppearancePreference,
  accent: AccentPreference = initialAccent(),
) {
  document.documentElement.dataset.theme = resolveTheme(preference);
  document.documentElement.dataset.accent = accent;
  localStorage.setItem(THEME_KEY, preference);
  localStorage.setItem(ACCENT_KEY, accent);
}

/**
 * Legacy values are migrated rather than discarded: "dark" was the only dark
 * theme before, and Coqui Dark is its successor.
 */
export function normalizeAppearance(value: string | null): AppearancePreference {
  if (value === "dark") return "coqui-dark";
  return THEME_VALUES.includes(value as AppearancePreference)
    ? (value as AppearancePreference)
    : "system";
}

export function initialAppearance(): AppearancePreference {
  return normalizeAppearance(localStorage.getItem(THEME_KEY));
}

export function initialAccent(): AccentPreference {
  const saved = localStorage.getItem(ACCENT_KEY);
  return ACCENT_VALUES.includes(saved as AccentPreference)
    ? (saved as AccentPreference)
    : "green";
}

/** Keeps a "system" preference in step with the OS while the app is open. */
export function watchSystemAppearance(
  getPreference: () => AppearancePreference,
) {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = () => {
    if (getPreference() === "system") applyAppearance("system");
  };
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/**
 * The compact topbar control. It offers System / Dark / Light only; the full
 * theme and accent pickers live in Appearance settings.
 */
export function ThemeControls({
  value,
  onChange,
  compact = false,
}: {
  value: AppearancePreference;
  onChange: (next: AppearancePreference) => void;
  compact?: boolean;
}) {
  const items = [
    { value: "system" as const, label: "System", icon: Monitor },
    { value: "light" as const, label: "Light", icon: Sun },
    { value: "coqui-dark" as const, label: "Dark", icon: Moon },
  ];
  return (
    <div
      className={`theme-controls ${compact ? "compact" : ""}`}
      role="group"
      aria-label="Color theme"
    >
      {items.map((item) => {
        const Icon = item.icon;
        // Any dark theme keeps the Dark button lit, so switching to Midnight in
        // settings does not make this control look unset.
        const active =
          item.value === "coqui-dark"
            ? value !== "system" && value !== "light"
            : value === item.value;
        return (
          <button
            type="button"
            key={item.value}
            className={active ? "active" : ""}
            aria-pressed={active}
            onClick={() => onChange(item.value)}
          >
            <Icon aria-hidden="true" />
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
