import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StudentCenter } from "./StudentCenter";
import { applyAppearance, initialAppearance } from "./components/ThemeControls";
import "./tokens.css";
import "./styles.css";
import "./experience-overrides.css";

async function start() {
  applyAppearance(initialAppearance());
  document.documentElement.dataset.density = localStorage.getItem("student-center-density") === "power" ? "power" : "comfortable";
  if (import.meta.env.VITE_WDIO === "true") await import("@wdio/tauri-plugin");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <StudentCenter />
    </StrictMode>,
  );
}

void start();
