import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const alias = { "@": resolve(__dirname, "src/renderer") };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "renderer",
          environment: "happy-dom",
          include: ["src/renderer/**/*.test.tsx"],
          setupFiles: ["src/renderer/test-setup.ts"],
        },
      },
    ],
  },
});
