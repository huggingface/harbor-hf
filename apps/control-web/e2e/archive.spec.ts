import { expect, type BrowserContext, type Route, test } from "@playwright/test";
import type { RunView } from "../src/api";

const runId = "run-0123456789abcdef01234567";
const initial: RunView = {
  record: {
    schema_version: "v1",
    run_id: runId,
    created_at: "2026-01-01T00:00:00Z",
    submitted_by: "fixture-subject",
    role: "diagnostic",
    harbor_revision: "d".repeat(40),
    workbench_recipe: { name: "Archive fixture recipe" },
    submission: {
      benchmark: { name: "fixture-benchmark", preset: "fixture-preset" },
      harness: { agent: "fixture-agent", version: "1" },
      cost_ceiling_usd_per_trial: 1,
    },
    harbor_job_config: { agents: [{ name: "fixture-agent" }] },
  },
  state: {
    schema_version: "v1",
    run_id: runId,
    revision: 1,
    updated_at: "2026-01-01T00:00:00Z",
    actor: "fixture-subject",
    desired_state: "run",
    parent_jobs: [],
  },
  status: "finished",
  result: null,
  presentation: null,
};
function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}
/** One shared fixture store, deliberately independent of browser localStorage.
 * No runtime control service, live API, credentials, or infrastructure. */
function sharedFixture() {
  const run = structuredClone(initial);
  const requests: string[] = [];
  let failure = 0;
  return {
    run,
    requests,
    fail(status: number) {
      failure = status;
    },
    async install(
      context: BrowserContext,
      role: "operator" | "reader" = "operator",
      writeMode = "enabled",
    ) {
      await context.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        requests.push(`${request.method()} ${path}`);
        if (path === "/api/v1/session")
          return json(route, {
            authenticated: true,
            actor: { username: "fixture-user", role, transport: "session" },
          });
        if (path === "/api/v1/system")
          return json(route, {
            source_revision: "fixture",
            harbor_revision: "fixture",
            ready: true,
            write_mode: writeMode,
            projection: { runs: 1, trials: 0, parent_jobs: 0 },
            capacity: { max_active_parent_jobs: 1 },
            workbench: { runner: "disabled", setup_enabled: false },
            resources: { spaces: 1, buckets: 1, operator_secrets: 2 },
          });
        if (
          path === `/api/v1/runs/${runId}/presentation` &&
          request.method() === "PATCH"
        ) {
          if (failure)
            return json(
              route,
              {
                error: {
                  code: "fixture_failure",
                  message: "Archive update failed; reload before retrying",
                },
              },
              failure,
            );
          if (role !== "operator" || writeMode !== "enabled")
            return json(route, { error: { message: "Writes unavailable" } }, 403);
          const body = request.postDataJSON() as {
            archived: boolean;
            expected_revision: number;
          };
          if (body.expected_revision !== (run.presentation?.revision ?? 0))
            return json(
              route,
              {
                error: {
                  code: "presentation_conflict",
                  message: "Archive revision changed; reload before retrying",
                },
              },
              409,
            );
          if (body.archived !== (run.presentation?.archived ?? false))
            run.presentation = {
              schema_version: "v1",
              run_id: runId,
              archived: body.archived,
              revision: body.expected_revision + 1,
              updated_at: "2026-01-02T00:00:00Z",
              actor: "fixture-subject",
            };
          return json(route, run.presentation);
        }
        if (request.method() !== "GET") throw new Error("Unexpected fixture mutation");
        if (path === "/api/v1/runs") return json(route, { runs: [run] });
        if (path === `/api/v1/runs/${runId}`) return json(route, run);
        if (path.endsWith("/trials")) return json(route, { trials: [] });
        if (path.endsWith("/progress"))
          return json(route, {
            observed_at: new Date().toISOString(),
            jobs_observed_at: null,
            lock: null,
            trials: [],
            jobs: [],
          });
        if (path === "/api/v1/jobs") return json(route, { jobs: [] });
        if (path === "/api/v1/presets")
          return json(route, { benchmarks: [], agents: [] });
        if (path === "/api/v1/leaderboard") return json(route, { rows: [] });
        return json(route, { error: { message: "Unexpected fixture read" } }, 404);
      });
    },
  };
}

test("archive hides default list, survives reload and restores through direct terminal detail", async ({
  page,
  context,
}) => {
  const fixture = sharedFixture();
  await fixture.install(context);
  await page.goto("/runs");
  await expect(
    page.getByRole("cell", { name: "Archive fixture recipe 1", exact: true }),
  ).toBeVisible();
  await page.locator(`a[href="/runs/${runId}"]`).click();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Restore", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Runs", exact: true })
    .click();
  await expect(page.getByLabel("Archive visibility")).toHaveValue("not-archived");
  await expect(
    page.getByRole("cell", { name: "Archive fixture recipe 1", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Archive visibility").selectOption("archived");
  await page
    .getByRole("combobox", { name: "Run role", exact: true })
    .selectOption("diagnostic");
  await page.getByLabel("Search runs").fill("Archive fixture recipe");
  await expect(
    page.getByRole("cell", { name: "Archive fixture recipe 1", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Archive visibility")).toHaveValue("archived");
  await expect(
    page.getByRole("combobox", { name: "Run role", exact: true }),
  ).toHaveValue("diagnostic");
  await expect(page.getByLabel("Search runs")).toHaveValue("Archive fixture recipe");
  await page
    .getByRole("combobox", { name: "Run role", exact: true })
    .selectOption("final");
  await expect(
    page.getByRole("cell", { name: "Archive fixture recipe 1", exact: true }),
  ).toHaveCount(0);
  await page.goBack();
  await expect(
    page.getByRole("combobox", { name: "Run role", exact: true }),
  ).toHaveValue("diagnostic");
  await page.goto(`/runs/${runId}`);
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Archive", exact: true }),
  ).toBeVisible();
  await page.goto("/runs?archive=invalid&role=diagnostic&q=recipe");
  await expect(
    page.getByRole("cell", { name: "Archive fixture recipe 1", exact: true }),
  ).toBeVisible();
  expect(fixture.run.state).toEqual(initial.state);
  expect(fixture.requests.filter((request) => !request.startsWith("GET"))).toEqual(
    Array(2).fill(`PATCH /api/v1/runs/${runId}/presentation`),
  );
});

test("normal polling shares archive across two independent browser contexts without overview progress queries", async ({
  browser,
  page,
  context,
}) => {
  const fixture = sharedFixture();
  await fixture.install(context);
  const other = await browser.newContext();
  await fixture.install(other);
  try {
    const list = await other.newPage();
    await list.clock.install();
    await list.goto("/runs");
    await expect(
      list.getByRole("cell", { name: "Archive fixture recipe 1", exact: true }),
    ).toBeVisible();
    await page.goto(`/runs/${runId}`);
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Restore", exact: true }),
    ).toBeVisible();
    fixture.requests.length = 0;
    await list.clock.fastForward(10_001);
    await expect(
      list.getByRole("cell", { name: "Archive fixture recipe 1", exact: true }),
    ).toHaveCount(0);
    expect(fixture.requests).not.toContain(`GET /api/v1/runs/${runId}/progress`);
    await list.getByLabel("Archive visibility").selectOption("all");
    await expect(
      list.getByRole("cell", { name: "Archive fixture recipe 1", exact: true }),
    ).toBeVisible();
  } finally {
    await other.close();
  }
});

for (const [role, mode] of [
  ["reader", "enabled"],
  ["operator", "disabled"],
] as const) {
  test(`archive actions hidden for ${role}/${mode}, shared detail readable`, async ({
    page,
    context,
  }) => {
    const fixture = sharedFixture();
    await fixture.install(context, role, mode);
    fixture.run.presentation = {
      schema_version: "v1",
      run_id: runId,
      archived: true,
      revision: 1,
      updated_at: "2026-01-02T00:00:00Z",
      actor: "fixture-subject",
    };
    await page.goto(`/runs/${runId}`);
    await expect(page.getByRole("heading", { name: "Run detail" })).toBeVisible();
    await expect(page.getByText("Archived", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Archive|Restore)$/ })).toHaveCount(
      0,
    );
  });
}
for (const status of [409, 500]) {
  test(`failed archive ${status} is visible with no optimistic visibility loss`, async ({
    page,
    context,
  }) => {
    const fixture = sharedFixture();
    fixture.fail(status);
    await fixture.install(context);
    await page.goto(`/runs/${runId}`);
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Archive update failed" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Archive", exact: true }),
    ).toBeEnabled();
    expect(fixture.run.presentation).toBeNull();
    await page.goto("/runs");
    await expect(
      page.getByRole("cell", { name: "Archive fixture recipe 1", exact: true }),
    ).toBeVisible();
  });
}

test("unknown archive remains discoverable; successful cached GET cannot unblock unavailable writes", async ({
  page,
  context,
}) => {
  const fixture = sharedFixture();
  fixture.run.presentation_available = false;
  await fixture.install(context);
  await page.goto("/runs");
  await expect(page.getByText("Archive state unavailable (unknown)")).toBeVisible();
  await page.goto(`/runs/${runId}`);
  await expect(
    page.getByRole("button", { name: "Archive", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Reload archive state" }).click();
  await expect(
    page.getByRole("button", { name: "Archive", exact: true }),
  ).toBeDisabled();
  expect(fixture.requests.every((request) => request.startsWith("GET"))).toBe(true);
  fixture.run.presentation_available = true;
  await page.getByRole("button", { name: "Reload archive state" }).click();
  await expect(
    page.getByRole("button", { name: "Archive", exact: true }),
  ).toBeEnabled();
});

test("polling shares unavailable last-known archives and valid resynchronization across contexts", async ({
  browser,
  page,
  context,
}) => {
  const fixture = sharedFixture();
  await fixture.install(context);
  const other = await browser.newContext();
  await fixture.install(other);
  try {
    await page.goto(`/runs/${runId}`);
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Restore", exact: true }),
    ).toBeVisible();
    const detail = await other.newPage();
    await detail.clock.install();
    await detail.goto(`/runs/${runId}`);
    fixture.run.presentation_available = false;
    await detail.clock.fastForward(10_001);
    await expect(
      detail.getByText(/Archive state unavailable \(last known\)/),
    ).toBeVisible();
    await expect(
      detail.getByRole("button", { name: "Restore", exact: true }),
    ).toBeDisabled();
    await page.goto("/runs");
    await expect(page.getByText("Archive state unavailable (last known)")).toHaveCount(
      0,
    );
    await page.getByLabel("Archive visibility").selectOption("archived");
    await expect(
      page.getByText("Archive state unavailable (last known)"),
    ).toBeVisible();
    fixture.run.presentation_available = true;
    await detail.clock.fastForward(10_001);
    await expect(
      detail.getByRole("button", { name: "Restore", exact: true }),
    ).toBeEnabled();
    await detail.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(
      detail.getByRole("button", { name: "Archive", exact: true }),
    ).toBeVisible();
  } finally {
    await other.close();
  }
});

test("an uncertain save followed by a synchronized conflict exits the stale revision retry cycle", async ({
  page,
  context,
}) => {
  const fixture = sharedFixture();
  await fixture.install(context);
  let attempts = 0;
  await context.route(`**/api/v1/runs/${runId}/presentation`, async (route) => {
    attempts += 1;
    const body = route.request().postDataJSON() as {
      expected_revision: number;
      archived: boolean;
    };
    if (attempts <= 2) {
      expect(body).toEqual({ expected_revision: 0, archived: true });
      if (attempts === 2) {
        // Mock the server's fresh validated Bucket read and conflict synchronization.
        fixture.run.presentation = {
          schema_version: "v1",
          run_id: runId,
          revision: 1,
          archived: true,
          actor: "fixture-subject",
          updated_at: "2026-01-02T00:00:00Z",
        };
        fixture.run.presentation_available = true;
      }
      return json(
        route,
        {
          error: {
            code:
              attempts === 1 ? "presentation_update_failed" : "presentation_conflict",
            message: "Archive state requires synchronization",
          },
        },
        attempts === 1 ? 503 : 409,
      );
    }
    expect(body).toEqual({ expected_revision: 1, archived: false });
    return route.fallback();
  });
  await page.goto(`/runs/${runId}`);
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Archive state requires synchronization" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Archive", exact: true }),
  ).toBeEnabled();
  expect(attempts).toBe(1); // No automatic mutation retry.
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Restore", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Archive", exact: true }),
  ).toBeEnabled();
  expect(attempts).toBe(3);
  expect(fixture.run.presentation?.revision).toBe(2);
});
