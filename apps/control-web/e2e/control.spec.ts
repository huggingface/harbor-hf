import { expect, test } from "@playwright/test";

test("shows the operational overview on desktop and mobile", async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        actor: { subject: "operator", role: "operator", transport: "session" },
      },
    }),
  );
  await page.route("**/api/v1/system", (route) =>
    route.fulfill({
      json: {
        source_revision: "test-revision",
        write_mode: "canary",
        projection: { ready: true, object_count: 12 },
        resource_contract: { spaces: 1, buckets: 1, operator_secrets: 1 },
      },
    }),
  );
  await page.route("**/api/v1/campaigns", (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
  await page.route("**/api/v1/endpoints", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route("**/api/v1/events", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("All observed endpoints safe")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});
