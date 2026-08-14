import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // src-tauri holds Rust tests; vitest has no business walking a 39 MB JRE.
    exclude: ["**/node_modules/**", "**/src-tauri/**", "**/dist/**"],
  },
});
