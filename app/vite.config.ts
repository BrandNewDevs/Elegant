import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer"),
  plugins: [react()],
  resolve: {
    alias: { "@": resolve(import.meta.dirname, "src/renderer") },
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        meetings: resolve(import.meta.dirname, "src/renderer/meetings.html"),
        setup: resolve(import.meta.dirname, "src/renderer/setup.html"),
        prompt: resolve(import.meta.dirname, "src/renderer/prompt.html"),
      },
    },
  },
  base: "./",
});
