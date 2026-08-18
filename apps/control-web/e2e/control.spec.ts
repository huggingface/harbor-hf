import { expect, test } from "@playwright/test";

const session = {
  authenticated: true,
  expires_at: "2026-08-18T12:00:00.000Z",
  actor: { username: "test-user", role: "operator", transport: "session" },
};

function system(writeMode: "disabled" | "canary" | "enabled" = "canary") {
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

test("disables campaign launch when writes are disabled", async ({ page }) => {
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
  await page.goto("/campaigns");
  await expect(page.getByRole("button", { name: "Launch" })).toBeDisabled();
  await expect(page.getByText(/role grants permission/i)).toBeVisible();
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
  await expect(page.getByText("Campaign not found")).toHaveCount(0);
});
