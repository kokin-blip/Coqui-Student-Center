import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Kept separate from vite.config.mjs so the Tauri dev/build path stays exactly
// as it was; this config is only ever loaded by `npm run test`.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.tsx", "test/**/*.test.ts"],
    css: false,
    // Rendering the whole interface boots an async bootstrap; jsdom needs more
    // than the 5s default before queries are allowed to settle.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
