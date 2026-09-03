import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StudentCenter } from "./StudentCenter";
import { applyAppearance } from "./components/ThemeControls";
import "./tokens.css";
import "./styles.css";
import "./experience-overrides.css";
import "./features/shell/desktop-shell.css";
import { applyInterfacePreferences, initialInterfacePreferences } from "./features/shell/interfacePreferences";

async function start() {
  const preferences = initialInterfacePreferences();
  applyInterfacePreferences(preferences);
  applyAppearance(preferences.themes[preferences.mode]);
  if (import.meta.env.VITE_WDIO === "true") await import("@wdio/tauri-plugin");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <StudentCenter />
    </StrictMode>,
  );
}

void start();
