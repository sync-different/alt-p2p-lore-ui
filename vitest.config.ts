import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The same compile-time constants vite.config.ts injects. Tests render the real components,
  // and a component that shows the build number must not need a stub to be rendered at all.
  // Fixed values rather than the real files: a test asserting on a version should fail when
  // someone changes what is *shown*, not when the counter ticks.
  define: {
    __APP_VERSION__: JSON.stringify("0.0.0-test"),
    __APP_BUILD__: JSON.stringify(0),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // src-tauri holds Rust tests; vitest has no business walking a 39 MB JRE.
    exclude: ["**/node_modules/**", "**/src-tauri/**", "**/dist/**"],
  },
});
