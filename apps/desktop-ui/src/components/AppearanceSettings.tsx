import { Check } from "lucide-react";
import { useState } from "react";
import type { InterfaceMode } from "../features/shell/interfacePreferences";
import {
  ACCENTS,
  AccentPreference,
  AppearancePreference,
  resolveTheme,
  THEMES,
} from "./ThemeControls";

/**
 * Theme and accent are chosen separately so any accent works on any theme.
 *
 * The previews carry data-theme/data-accent themselves rather than repeating
 * the palettes in JS: the token blocks are plain attribute selectors, so they
 * apply to any element that wears the attribute, not only the document root.
 */
export function AppearanceSettings({
  interfaceMode,
  onInterfaceMode,
  theme,
  accent,
  onTheme,
  onAccent,
}: {
  interfaceMode?: InterfaceMode;
  onInterfaceMode?: (mode: InterfaceMode) => void;
  theme: AppearancePreference;
  accent: AccentPreference;
  onTheme: (next: AppearancePreference) => void;
  onAccent: (next: AccentPreference) => void;
}) {
  const [density,setDensity]=useState<"comfortable"|"power">(()=>localStorage.getItem("student-center-density")==="power"?"power":"comfortable");
  const chooseDensity=(next:"comfortable"|"power")=>{if(onInterfaceMode){onInterfaceMode(next==="power"?"compact":"comfy");return;}setDensity(next);document.documentElement.dataset.density=next;localStorage.setItem("student-center-density",next);};
  const chosenDensity = interfaceMode ? (interfaceMode === "compact" ? "power" : "comfortable") : density;
  return (
    <div className="appearance-settings">
      <fieldset>
        <legend>Theme</legend>
        <p className="field-help">
          System follows your operating system and switches automatically.
        </p>
        <div className="theme-grid" role="radiogroup" aria-label="Theme">
          {THEMES.map((item) => (
            <button
              type="button"
              key={item.value}
              role="radio"
              aria-checked={theme === item.value}
              className={`theme-option ${theme === item.value ? "selected" : ""}`}
              onClick={() => onTheme(item.value)}
            >
              <span
                className="theme-preview"
                data-theme={resolveTheme(item.value)}
                data-accent={accent}
                aria-hidden="true"
              >
                <i className="theme-preview-sidebar" />
                <i className="theme-preview-accent" />
              </span>
              <span className="theme-option-name">{item.label}</span>
              {theme === item.value && <Check aria-hidden="true" />}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Accent color</legend>
        <p className="field-help">
          Used for the selected item, primary buttons, and priority — not for
          body text.
        </p>
        <div className="accent-row" role="radiogroup" aria-label="Accent color">
          {ACCENTS.map((item) => (
            <button
              type="button"
              key={item.value}
              role="radio"
              aria-checked={accent === item.value}
              aria-label={item.label}
              title={item.label}
              className={`accent-option ${accent === item.value ? "selected" : ""}`}
              data-theme={resolveTheme(theme)}
              data-accent={item.value}
              onClick={() => onAccent(item.value)}
            >
              <span className="accent-dot" aria-hidden="true">
                {accent === item.value && <Check aria-hidden="true" />}
              </span>
              <small>{item.label}</small>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset><legend>Interface density</legend><p className="field-help">Comfy gives your day room to breathe. Compact combines your week, work queue, and inspector.</p><div className="theme-controls" role="radiogroup" aria-label="Interface density"><button type="button" role="radio" aria-checked={chosenDensity==="comfortable"} className={chosenDensity==="comfortable"?"active":""} onClick={()=>chooseDensity("comfortable")}>Comfy</button><button type="button" role="radio" aria-checked={chosenDensity==="power"} className={chosenDensity==="power"?"active":""} onClick={()=>chooseDensity("power")}>Compact</button></div></fieldset>
    </div>
  );
}
