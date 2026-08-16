import { Monitor, Moon, Sun } from "lucide-react";

export type AppearancePreference = "system" | "light" | "dark";

export function applyAppearance(preference: AppearancePreference) {
  document.documentElement.dataset.theme = preference;
  localStorage.setItem("student-center-appearance", preference);
}

export function initialAppearance(): AppearancePreference {
  const saved = localStorage.getItem("student-center-appearance");
  return saved === "light" || saved === "dark" ? saved : "system";
}

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
    { value: "dark" as const, label: "Dark", icon: Moon },
  ];
  return (
    <div className={`theme-controls ${compact ? "compact" : ""}`} role="group" aria-label="Color theme">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            type="button"
            key={item.value}
            className={value === item.value ? "active" : ""}
            aria-pressed={value === item.value}
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
