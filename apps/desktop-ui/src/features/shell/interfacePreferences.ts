import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "../../native";
import {
  normalizeAppearance,
  type AppearancePreference,
} from "../../components/ThemeControls";

export type InterfaceMode = "comfy" | "compact";
export type InterfacePreferences = {
  mode: InterfaceMode;
  themes: Record<InterfaceMode, AppearancePreference>;
};
const KEY = "coqui-interface-preferences-v1";

export function initialInterfacePreferences(): InterfacePreferences {
  if (import.meta.env.DEV && !isDesktop()) {
    const reference = new URLSearchParams(location.search).get("reference");
    if (reference === "comfy" || reference === "compact")
      return {
        mode: reference,
        themes: { comfy: "light", compact: "coqui-dark" },
      };
  }
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (saved && ["comfy", "compact"].includes(saved.mode) && saved.themes) {
      return {
        mode: saved.mode,
        themes: {
          comfy: normalizeAppearance(saved.themes.comfy),
          compact: normalizeAppearance(saved.themes.compact),
        },
      };
    }
  } catch {
    /* A malformed UI cache never prevents startup. Native storage wins. */
  }
  const mode =
    localStorage.getItem("student-center-density") === "power"
      ? "compact"
      : "comfy";
  const legacy = localStorage.getItem("student-center-appearance");
  return {
    mode,
    themes: {
      comfy: "light",
      compact: "coqui-dark",
      ...(legacy ? { [mode]: normalizeAppearance(legacy) } : {}),
    },
  };
}

export function applyInterfacePreferences(value: InterfacePreferences) {
  document.documentElement.dataset.interfaceMode = value.mode;
  // Unmigrated routes retain their existing density contract during the rebuild.
  document.documentElement.dataset.density =
    value.mode === "compact" ? "power" : "comfortable";
  localStorage.setItem(KEY, JSON.stringify(value));
  localStorage.setItem(
    "student-center-density",
    value.mode === "compact" ? "power" : "comfortable",
  );
}

export async function loadInterfacePreferences(): Promise<InterfacePreferences> {
  const legacy = initialInterfacePreferences();
  if (!isDesktop()) return legacy;
  return invoke<InterfacePreferences>("get_interface_preferences", {
    legacyMode: legacy.mode,
  });
}

export async function saveInterfacePreferences(
  value: InterfacePreferences,
): Promise<InterfacePreferences> {
  if (isDesktop())
    return invoke<InterfacePreferences>("set_interface_preferences", {
      preferences: value,
    });
  return value;
}
