import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Version and build number, baked in at compile time.
 *
 * Read here rather than fetched from Rust at runtime so the number belongs to *this bundle*
 * and cannot disagree with the code around it. The build counter is bumped by
 * `scripts/bump-build.mjs` from `beforeBuildCommand`, so it counts builds rather than reloads.
 */
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
let build = 0;
try {
  build = JSON.parse(readFileSync(new URL("./build-number.json", import.meta.url), "utf8")).build;
} catch {
  // A dev run before the first build has no counter yet; 0 reads honestly as "not a build".
}

// Tauri expects a fixed port and fails if it is taken, rather than silently moving.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_BUILD__: JSON.stringify(build),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
