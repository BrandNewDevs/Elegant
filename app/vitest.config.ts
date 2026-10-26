import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const alias = { "@": resolve(__dirname, "src/renderer") };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "native-engine",
          environment: "node",
          include: ["src/engine/real-engine.test.ts"],
        },
      },
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/renderer/**", "src/engine/real-engine.test.ts"],
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "renderer",
          environment: "happy-dom",
          include: ["src/renderer/**/*.test.{ts,tsx}"],
          setupFiles: ["src/renderer/test-setup.ts"],
        },
      },
    ],
  },
});
