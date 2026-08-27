import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  root: import.meta.dirname,
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  define: {
    "import.meta.env.VITE_WDIO": JSON.stringify(mode === "e2e" ? "true" : "false")
  },
  css: { postcss: { plugins: [] } },
  build: { target: "chrome120", sourcemap: true }
}));
