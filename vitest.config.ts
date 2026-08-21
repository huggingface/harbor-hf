import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 85,
        functions: 85,
        lines: 85,
        statements: 85,
      },
    },
    exclude: ["**/node_modules/**", "**/dist/**", "**/e2e/**"],
    include: ["{apps,packages,scripts}/**/*.{test,spec}.ts", "apps/**/*.test.tsx"],
    testTimeout: 15_000,
  },
});
