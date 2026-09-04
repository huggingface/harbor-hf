import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "../../../../test-results/installer",
  timeout: 20_000,
  workers: 1,
});
