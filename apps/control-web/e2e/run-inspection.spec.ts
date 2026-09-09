import { expect, test } from "@playwright/test";

for (const view of ["refresh", "pending-run", "pending-jobs"] as const) {
  test(`Job elapsed advances independently: ${view}`, async ({ page }) => {
    const id = "run-synthetic";
    const base = `/api/v1/runs/${id}`;
    const started = "2026-01-01T00:00:00Z";
    const run = {
      record: {
        run_id: id,
        created_at: started,
        role: "diagnostic",
        harbor_job_config: { agents: [], timeout_multiplier: 2 },
        submission: {
          benchmark: { name: "synthetic", preset: "sample" },
          cost_ceiling_usd_per_trial: 1,
        },
        pricing: {
          currency: "USD",
          input_usd_per_million: 2,
          cached_usd_per_million: 1,
          output_usd_per_million: 3,
        },
      },
      state: { desired_state: "run", parent_jobs: [] },
      status: "running",
      result: { stats: { cost_usd: 1 } },
      shared_estimate: { cost_usd: null, unavailable_reason: "usage_unavailable" },
    };
    const job = {
      id: "job-synthetic",
      run_id: id,
      role: "parent",
      stage: "running",
      created_at: started,
      started_at: started,
      finished_at: null,
    };
    const counts = new Map<string, number>();
    const writes: string[] = [];
    let holdRefresh = false;
    let releaseRefresh = () => {};
    const pending = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      counts.set(path, (counts.get(path) ?? 0) + 1);
      if (route.request().method() !== "GET") {
        writes.push(route.request().method());
        await route.abort();
        return;
      }
      if (holdRefresh && path === "/api/v1/jobs") await pending;
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
        "/api/v1/runs": { runs: [run] },
        "/api/v1/jobs": {
          jobs: [
            job,
            { ...job, id: "job-missing-start", started_at: null },
            {
              ...job,
              id: "job-ended",
              stage: "stopped",
              finished_at: "2026-01-01T00:01:00Z",
            },
          ],
        },
        [base]: run,
        [`${base}/trials`]: { trials: [] },
        [`${base}/progress`]: {
          observed_at: started,
          jobs_observed_at: started,
          lock: null,
          trials: [],
          jobs: [],
        },
      };
      await route.fulfill({ json: responses[path] ?? {} });
    });
    await page.clock.install({ time: new Date("2026-01-01T00:02:00Z") });
    await page.clock.setFixedTime(new Date("2026-01-01T00:02:00Z"));
    await page.goto(view === "pending-jobs" ? "/jobs" : `/runs/${id}`);
    await expect(page.getByText("Elapsed since start: 2m 0s")).toBeVisible();
    await expect(page.getByText("Duration: 1m 0s")).toBeVisible();
    if (view !== "pending-jobs") {
      const summary = page.getByRole("region", { name: "Run summary" });
      await expect(
        summary.getByLabel("Reported cost (USD): 1", { exact: true }),
      ).toBeVisible();
      await expect(
        summary.getByText("Reported usage unavailable or invalid"),
      ).toBeVisible();
      await expect(
        summary.getByLabel("Launch estimate (USD): unavailable", { exact: true }),
      ).toBeVisible();
      const timeouts = summary.getByText("Configured timeouts");
      await timeouts.hover();
      await expect(page.getByRole("tooltip")).toContainText("timeout_multiplier: 2");
      await expect(timeouts).not.toHaveCSS("cursor", "help");
    }
    await expect(page.getByText("Elapsed since start: Unavailable")).toBeVisible();
    const paths =
      view === "pending-jobs"
        ? ["/api/v1/jobs"]
        : [base, `${base}/trials`, `${base}/progress`, "/api/v1/jobs"];
    holdRefresh = view !== "refresh";
    const before = paths.map((path) => counts.get(path) ?? 0);
    await page.clock.setFixedTime(new Date("2026-01-01T00:02:10Z"));
    await page.clock.runFor(10_100);
    for (const [index, path] of paths.entries()) {
      await expect.poll(() => counts.get(path)).toBe(before[index] + 1);
    }
    await expect(page.getByText("Elapsed since start: 2m 10s")).toBeVisible();
    await expect(page.getByText("Duration: 1m 0s")).toBeVisible();
    if (holdRefresh) {
      // No response or error has settled since the initial snapshot.
      await page.clock.setFixedTime(new Date("2026-01-01T00:02:30Z"));
      await page.clock.runFor(20_000);
      await expect(page.getByText("Elapsed since start: 2m 30s")).toBeVisible();
      await expect(page.getByText("Duration: 1m 0s")).toBeVisible();
      await expect(page.getByText("Elapsed since start: Unavailable")).toBeVisible();
      expect(counts.get("/api/v1/jobs")).toBe(2);
    }
    releaseRefresh();
    expect(writes).toEqual([]);
  });
}
