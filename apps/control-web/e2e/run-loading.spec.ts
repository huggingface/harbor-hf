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
        await route.fulfill({
          status: 503,
          json: {
            error: {
              code: "synthetic_unavailable",
              message: "Synthetic unavailable",
              retry_at: "2026-09-11T12:30:00Z",
              request_id: "synthetic-request",
            },
          },
        });
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
    const checkErrorDetails = async (stale: boolean) => {
      const before = await refresh.boundingBox();
      const following = await refresh.evaluate(
        (element) => element.nextElementSibling?.getBoundingClientRect().y,
      );
      const summary = entry("Run details").getByText("Details", { exact: true });
      await expect(summary).toHaveAccessibleName("Run details error details");
      const disclosure = entry("Run details").locator("details");
      await expect(disclosure).not.toHaveAttribute("open");
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(disclosure).toHaveAttribute("open", "");
      await expect(
        disclosure.getByText(
          stale
            ? "The latest refresh failed: Synthetic unavailable"
            : "Synthetic unavailable",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        disclosure.getByText("Code: synthetic_unavailable · HTTP 503"),
      ).toBeVisible();
      const retryTime = await page.evaluate(() =>
        new Date("2026-09-11T12:30:00Z").toLocaleTimeString(),
      );
      await expect(disclosure.getByText(`Retry after ${retryTime}.`)).toBeVisible();
      await expect(disclosure.getByText("synthetic-request")).toBeVisible();
      if (stale) await expect(disclosure.getByText("Showing saved data")).toBeVisible();
      expect(await refresh.boundingBox()).toEqual(before);
      expect(
        await refresh.evaluate(
          (element) => element.nextElementSibling?.getBoundingClientRect().y,
        ),
      ).toBe(following);
      const panel = disclosure.locator("div").first();
      await expect(panel).toHaveCSS("position", "absolute");
      await expect(panel).toHaveCSS("background-color", "oklch(0.129 0.042 264.695)");
      const bounds = await panel.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
      await page.keyboard.press("Escape");
      await expect(disclosure).not.toHaveAttribute("open");
      await expect(summary).toBeFocused();
      await page.keyboard.press("Space");
      await expect(disclosure).toHaveAttribute("open", "");
      await page.keyboard.press("Space");
      await expect(disclosure).not.toHaveAttribute("open");
      expect(await refresh.boundingBox()).toEqual(before);
    };
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
    const refreshingBounds = await refresh.boundingBox();
    failed = true;
    held.clear();
    release();
    await page.clock.runFor(15_000);
    await expect(refresh.getByText("Refresh failed · saved data")).toHaveCount(4);
    expect(await refresh.boundingBox()).toEqual(refreshingBounds);
    await checkErrorDetails(true);
    await expect(page.getByText("7 / -", { exact: true })).toBeVisible();
    if (shots)
      await page.screenshot({ path: `${shots}/${width}-error.png`, fullPage: true });
    await page.reload();
    await page.clock.runFor(15_000);
    await expect(refresh.getByText("Unavailable", { exact: true })).toHaveCount(3);
    // Progress is not mounted until the initial run response succeeds.
    await expect(entry("Trial progress").getByText("Waiting…")).toBeVisible();
    await checkErrorDetails(false);
    failed = false;
    await entry("Run details")
      .getByRole("button", { name: "Retry Run details" })
      .click();
    await expect(entry("Run details").getByText("Idle")).toBeVisible();
    await expect(entry("Run details").locator("details")).toHaveCount(0);
    await expect(page.getByText("No trial result is available yet.")).toHaveCount(0);
  });
}
