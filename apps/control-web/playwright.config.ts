import { defineConfig } from "@playwright/test";

const port = Number(process.env.HARBOR_HF_E2E_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid HARBOR_HF_E2E_PORT");

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
    port,
    reuseExistingServer: !process.env.CI,
  },
});
