import { cp } from "node:fs/promises";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
// @ts-expect-error The build helper is plain ESM shared with its focused test.
import { copyRuntimeResources } from "./scripts/runtime-resources.mjs";

// PicPatch's fixed development endpoint; strict, so it never drifts to another app's port.
export const DEV_PORT = 23297;

/**
 * The SDK is bundled from its TypeScript source (sdk-conventions). It finds its Python
 * worker and protocol beside its own modules, so the main build keeps the module layout
 * (out/main/sdk/src/...) and this places the worker sources and locks where those
 * package-relative paths resolve: never development environments or caches.
 */
function sdkResources(): Plugin {
  return {
    name: "picpatch-sdk-resources",
    async writeBundle(options) {
      const sdk = resolve(options.dir!, "sdk");
      await cp(resolve("sdk/protocol"), resolve(sdk, "protocol"), { recursive: true });
      await copyRuntimeResources(resolve("sdk/runtimes"), resolve(sdk, "runtimes"));
    },
  };
}

export default defineConfig({
  main: {
    plugins: [sdkResources()],
    build: {
      externalizeDeps: { exclude: ["picpatchsdk"] },
      rollupOptions: {
        input: {
          main: resolve("src/desktop/main.ts"),
          "backup-worker": resolve("src/app/backup-worker.ts"),
          "records-worker": resolve("src/app/records-worker.ts"),
          "records-reader-worker": resolve("src/app/records-reader-worker.ts"),
        },
        output: { preserveModules: true, preserveModulesRoot: resolve("."), entryFileNames: "[name].js" },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { preload: resolve("src/desktop/preload.ts"), "records-preload": resolve("src/desktop/records-preload.ts") },
        // A sandboxed preload must be CommonJS.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react()],
    server: { host: "127.0.0.1", port: DEV_PORT, strictPort: true },
    build: {
      rollupOptions: { input: { index: resolve("src/renderer/index.html"), records: resolve("src/renderer/records.html") } },
    },
  },
});
