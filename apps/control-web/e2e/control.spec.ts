import { expect, test } from "@playwright/test";

const session = {
  authenticated: true,
  expires_at: "2026-08-18T12:00:00.000Z",
  actor: { username: "test-user", role: "operator", transport: "session" },
};

function system(writeMode: "disabled" | "enabled" = "enabled") {
  return {
    source_revision: "test-revision-0123456789abcdef",
    write_mode: writeMode,
    projection: {
      ready: true,
      rebuilding: false,
      object_count: 12,
      last_rebuild_at: "2026-08-18T00:00:00.000Z",
      last_sync_at: "2026-08-18T00:01:00.000Z",
      event_cursor: null,
      integrity_error: null,
    },
    resource_contract: { spaces: 1, buckets: 1, operator_secrets: 2 },
  };
}

test("shows the operational overview on desktop and mobile", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/v1/system", (route) => route.fulfill({ json: system() }));
  await page.route("**/api/v1/campaigns", (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
  await page.route("**/api/v1/endpoints", (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
  await page.route("**/api/v1/events", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("All observed endpoints safe")).toBeVisible();
  await expect(page.getByText("test-revision-0123456789abcdef")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test("disables campaign launch and keeps account details compact", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/v1/system", (route) =>
    route.fulfill({ json: system("disabled") }),
  );
  await page.route("**/api/v1/campaigns", (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
  await page.route("**/api/v1/events", (route) => route.abort());
  await page.goto("/runs");
  await expect(page.getByRole("button", { name: "Start a run" })).toBeDisabled();
  const details = page.getByRole("button", { name: "Account and session details" });
  const guidance = page.getByText(/role grants permission/i);
  await expect(guidance).toBeHidden();
  await details.focus();
  await expect(guidance).toBeVisible();
  await expect(page.getByText(/session expires/i)).toBeVisible();
});

test("requires confirmation before starting a run", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/v1/system", (route) =>
    route.fulfill({ json: system("enabled") }),
  );
  await page.route("**/api/v1/campaigns", (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
  await page.route("**/api/v1/profiles**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            profile_id: "sha256:benchmark",
            profile_kind: "benchmark",
            name: "terminal-bench-2-1-diagnostic-1",
            source: "built-in",
            promotion_state: "approved",
            alias: "terminal-bench-2-1-diagnostic-1",
            approved_aliases: ["terminal-bench-2-1-diagnostic-1"],
            spec: {
              benchmark: "terminal-bench-2-1",
              task_ids: ["task-a"],
              trial_indices: [1],
            },
            created_at: "2026-08-16T00:00:00.000Z",
          },
          {
            profile_id: "sha256:model",
            profile_kind: "model",
            name: "gpt-oss-20b",
            source: "built-in",
            promotion_state: "approved",
            alias: "gpt-oss-20b",
            approved_aliases: ["gpt-oss-20b"],
            spec: { model_id: "openai/gpt-oss-20b", revision: "abc" },
            created_at: "2026-08-16T00:00:00.000Z",
          },
          {
            profile_id: "sha256:harness",
            profile_kind: "harness",
            name: "opencode",
            source: "built-in",
            promotion_state: "approved",
            alias: "opencode",
            approved_aliases: ["opencode"],
            spec: { agent: "opencode", reasoning_effort: "off" },
            created_at: "2026-08-16T00:00:00.000Z",
          },
          {
            profile_id: "sha256:deployment",
            profile_kind: "deployment",
            name: "tb21-gpt-oss-20b-opencode-providers",
            source: "built-in",
            promotion_state: "approved",
            alias: "tb21-gpt-oss-20b-opencode-providers",
            approved_aliases: ["tb21-gpt-oss-20b-opencode-providers"],
            spec: {
              models: ["gpt-oss-20b"],
              harnesses: ["opencode"],
              sandbox_template: {
                inference_upstream: "https://router.huggingface.co/v1",
              },
            },
            created_at: "2026-08-16T00:00:00.000Z",
          },
          {
            profile_id: "sha256:policy",
            profile_kind: "launch_policy",
            name: "tb21-diagnostic-1",
            source: "built-in",
            promotion_state: "approved",
            alias: "tb21-diagnostic-1",
            approved_aliases: ["tb21-diagnostic-1"],
            spec: { reservation_microusd: 1000, publication_role: "diagnostic" },
            created_at: "2026-08-16T00:00:00.000Z",
          },
        ],
        next_cursor: null,
      },
    }),
  );
  await page.route("**/api/v1/events", (route) => route.abort());
  await page.goto("/runs");
  await page.getByRole("button", { name: "Start a run" }).click();
  const create = page.getByRole("button", { name: "Start run" });
  await expect(create).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Launch policy" })
    .selectOption("tb21-diagnostic-1");
  await page.getByRole("checkbox").check();
  await expect(create).toBeEnabled();
  await page.getByText("Cost ceiling, USD", { exact: true }).hover();
  await expect(
    page.getByText(/defaults to twice the estimated reservation/i),
  ).toBeVisible();
});

test("shows campaign failures as errors rather than missing data", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/v1/system", (route) => route.fulfill({ json: system() }));
  await page.route("**/api/v1/campaigns/campaign-error", (route) =>
    route.fulfill({
      status: 403,
      json: {
        error: {
          code: "access_denied",
          message: "access denied",
          request_id: "browser-request-id",
        },
      },
    }),
  );
  await page.route("**/api/v1/campaigns/campaign-error/tasks**", (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
  await page.route("**/api/v1/events", (route) => route.abort());
  await page.goto("/campaigns/campaign-error");
  await expect(page.getByText("Forbidden")).toBeVisible();
  await expect(page.getByText(/browser-request-id/)).toBeVisible();
  await expect(page.getByText("Run not found")).toHaveCount(0);
});
