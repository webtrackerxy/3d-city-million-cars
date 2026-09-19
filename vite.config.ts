import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { projectAssets } from "./tooling/vite-plugin-project-assets.ts";

// Cross-origin isolation is required for SharedArrayBuffer (vehicle state shared with
// the traffic worker). External tiles/basemaps must then be fetched with CORS, which
// MapLibre does by default.
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  // Workers created from blob/module URLs (MapLibre) fetch same-origin scripts under COEP;
  // the response must carry CORP or Chrome blocks it (ERR_BLOCKED_BY_RESPONSE).
  "Cross-Origin-Resource-Policy": "cross-origin",
};

export default defineConfig({
  plugins: [
    react(),
    // Serves assets/generated/** at /vehicles/** in dev, copies it into dist/vehicles on
    // build, and accepts POST /__bench/record to persist benchmark runs into docs/benchmarks/.
    projectAssets({ urlPrefix: "/vehicles", dir: "assets/generated", benchDir: "docs/benchmarks" }),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: { headers: isolationHeaders, port: 5173, strictPort: false },
  preview: { headers: isolationHeaders },
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  worker: { format: "es" },
});
