import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`independent Run detail loading and retained refresh at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const id = "run-synthetic";
    const base = `/api/v1/runs/${id}`;
    const run = {
      record: {
        run_id: id,
        created_at: "2026-01-01T00:00:00Z",
        role: "diagnostic",
        harbor_job_config: { agents: [] },
        submission: {
          benchmark: { name: "synthetic", preset: "sample" },
          cost_ceiling_usd: 1,
        },
      },
      state: { desired_state: "run", parent_jobs: [] },
      status: "running",
      result: { stats: { n_completed_trials: 7 } },
    };
    let release = () => {};
    let pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = new Set([base]);
    let releaseTrials = () => {};
    const initialTrials = new Promise<void>((resolve) => {
      releaseTrials = resolve;
    });
    let releaseJobs = () => {};
    const initialJobs = new Promise<void>((resolve) => {
      releaseJobs = resolve;
    });
    let failed = false;
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === `${base}/trials`) await initialTrials;
      if (path === "/api/v1/jobs") await initialJobs;
      if (held.has(path)) await pending;
      if (
        failed &&
        [base, `${base}/trials`, `${base}/progress`, "/api/v1/jobs"].includes(path)
      ) {
        await route.fulfill({ status: 503, json: { error: "Synthetic unavailable" } });
        return;
      }
      const responses: Record<string, unknown> = {
        "/api/v1/session": {
          authenticated: true,
          actor: {
            username: "synthetic-actor",
            role: "reader",
            transport: "development",
          },
        },
        "/api/v1/system": {
          workbench: { runner: "disabled" },
          write_mode: "disabled",
          resources: {},
        },
        "/api/v1/jobs": { jobs: [] },
        [base]: run,
        [`${base}/trials`]: { trials: [] },
        [`${base}/progress`]: {
          observed_at: "2026-01-01T00:00:00Z",
          jobs_observed_at: "2026-01-01T00:00:00Z",
          lock: null,
          trials: [],
          jobs: [],
        },
      };
      await route.fulfill({ json: responses[path] ?? {} });
    });
    await page.clock.install();
    await page.goto(`/runs/${id}`);
    const refresh = page.getByRole("region", { name: "Refresh status" });
    const entry = (label: string) =>
      refresh.getByRole("group", { name: `${label} refresh` });
    await expect(entry("Run details").getByText("Loading…")).toBeVisible();
    await expect(entry("Trials").getByText("Loading…")).toBeVisible();
    await expect(page.getByText("No trial result is available yet.")).toHaveCount(0);
    releaseTrials();
    await expect(page.getByText("No trial result is available yet.")).toBeVisible();
    held = new Set([`${base}/progress`]);
    release();
    pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await expect(entry("Trial progress").getByText("Loading…")).toBeVisible();
    await expect(page.getByText("0 tasks × 0 repeat slots")).toHaveCount(0);
    await expect(entry("Parent Jobs").getByText("Loading…")).toBeVisible();
    await expect(page.getByText("No parent Jobs are available.")).toHaveCount(0);
    releaseJobs();
    const shots = process.env.RUN_LOADING_SCREENSHOTS;
    if (shots)
      await page.screenshot({ path: `${shots}/${width}-initial.png`, fullPage: true });
    held.clear();
    release();
    await expect(entry("Trial progress").getByText("Loading…")).toHaveCount(0);
    held = new Set([base, `${base}/trials`, `${base}/progress`, "/api/v1/jobs"]);
    pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.clock.runFor(30_001);
    for (const label of ["Run details", "Trials", "Trial progress", "Parent Jobs"]) {
      await expect(entry(label).getByText("Refreshing…")).toBeVisible();
    }
    await expect(page.getByText("No trial result is available yet.")).toBeVisible();
    await expect(page.getByText("7 / -", { exact: true })).toBeVisible();
    if (shots)
      await page.screenshot({ path: `${shots}/${width}-refresh.png`, fullPage: true });
    failed = true;
    held.clear();
    release();
    await page.clock.runFor(15_000);
    await expect(refresh.getByText("Refresh failed · saved data")).toHaveCount(4);
    await expect(page.getByText("7 / -", { exact: true })).toBeVisible();
    if (shots)
      await page.screenshot({ path: `${shots}/${width}-error.png`, fullPage: true });
    await page.reload();
    await page.clock.runFor(15_000);
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByText("No trial result is available yet.")).toHaveCount(0);
  });
}
