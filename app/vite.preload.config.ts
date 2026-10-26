import { resolve } from "node:path";
import { defineConfig } from "vite";

/** Sandboxed preload scripts must be CommonJS, so the preload is bundled separately from the ES module main process. */
export default defineConfig({
  build: {
    outDir: resolve(import.meta.dirname, "dist/preload"),
    emptyOutDir: true,
    target: "node22",
    minify: false,
    lib: { entry: resolve(import.meta.dirname, "src/preload/preload.ts"), formats: ["cjs"], fileName: () => "preload.cjs" },
    rollupOptions: { external: ["electron"] },
  },
});
