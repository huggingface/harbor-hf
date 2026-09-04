import { chromium, expect, test } from "@playwright/test";
import { BrowserApplicationAuth } from "../browser-auth.js";

const origin = "https://control.example.invalid";

test("real browser fetch observes mocked HTTPS login, restart and redirect rejection", async () => {
  let signedIn = false;
  let redirect = false;
  let loginCount = 0;
  const requests: string[] = [];
  const adapter = new BrowserApplicationAuth(origin, "example-user", {
    environment: { DISPLAY: ":test" },
    pollMs: 10,
    timeoutMs: 10_000,
    // Only the test launcher is headless; all navigation is locally intercepted.
    launch: async (options) => {
      const browser = await chromium.launch({ ...options, headless: true });
      browser.on("context", async (context) => {
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          requests.push(url.origin + url.pathname + url.search);
          if (url.origin !== origin) return await route.abort();
          if (url.pathname === "/auth/login") {
            signedIn = true;
            loginCount += 1;
            return await route.fulfill({
              contentType: "text/html",
              body: "<h1>Mock login completed</h1>",
            });
          }
          if (url.pathname === "/api/v1/auth/session") {
            return await route.fulfill({
              status: signedIn ? 200 : 401,
              json: signedIn
                ? {
                    authenticated: true,
                    actor: {
                      username: "example-user",
                      role: "operator",
                      transport: "session",
                    },
                  }
                : { authenticated: false },
            });
          }
          if (url.pathname === "/api/v1/system") {
            if (redirect)
              return await route.fulfill({
                status: 302,
                headers: {
                  location: "https://other.example.invalid/private?token=not-real",
                },
              });
            return await route.fulfill({ json: { source_revision: "mock-revision" } });
          }
          return await route.fulfill({
            contentType: "text/html",
            body: "<h1>Mock control</h1>",
          });
        });
      });
      return browser;
    },
  });
  try {
    expect(await adapter.getJson(new URL("/api/v1/system", origin))).toEqual({
      status: 200,
      body: { source_revision: "mock-revision" },
    });
    signedIn = false;
    await adapter.getJson(new URL("/api/v1/system", origin));
    expect(loginCount).toBe(2);
    redirect = true;
    await expect(adapter.getJson(new URL("/api/v1/system", origin))).rejects.toThrow(
      "Browser verification failed",
    );
    expect(requests.every((url) => url.startsWith(origin))).toBe(true);
  } finally {
    await adapter.close();
  }
});
