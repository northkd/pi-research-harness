import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  root: __dirname,
  test: {
    name: "speed-plugin",
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
    environment: "node",
    pool: "forks",
    maxWorkers: 2,
  },
  resolve: {
    alias: {
      "@blackbelt-technology/pi-dashboard-speed-plugin": path.resolve(
        __dirname,
        "src/index.tsx",
      ),
    },
  },
});
