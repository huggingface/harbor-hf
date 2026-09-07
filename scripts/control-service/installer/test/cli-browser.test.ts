import { afterEach, expect, it, vi } from "vitest";
import { BrowserApplicationAuth } from "../browser-auth.js";
import { withBrowserAuthentication } from "../cli-browser.js";
import type { InstallerDependencies } from "../workflow.js";

afterEach(() => vi.restoreAllMocks());
const origin = "https://control.example.invalid";

it.each([false, true])(
  "closes the command browser and restores signal listeners on failure=%s",
  async (fails) => {
    const close = vi
      .spyOn(BrowserApplicationAuth.prototype, "close")
      .mockResolvedValue();
    const dependencies = {} as InstallerDependencies;
    const before = process.listenerCount("SIGINT");
    const result = withBrowserAuthentication(dependencies, async () => {
      const adapter = dependencies.applicationAuth?.(origin, "example-user");
      expect(dependencies.applicationAuth?.(origin, "example-user")).toBe(adapter);
      expect(() =>
        dependencies.applicationAuth?.("https://other.example.invalid", "example-user"),
      ).toThrow("binding changed");
      if (fails) throw new Error("workflow failed");
      return "passed";
    });
    if (fails) await expect(result).rejects.toThrow("workflow failed");
    else expect(await result).toBe("passed");
    expect(close).toHaveBeenCalledTimes(1);
    expect(dependencies.applicationAuth).toBeUndefined();
    expect(process.listenerCount("SIGINT")).toBe(before);
  },
);

it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
  "closes on %s and fails subsequent authentication",
  async (signal) => {
    const close = vi
      .spyOn(BrowserApplicationAuth.prototype, "close")
      .mockResolvedValue();
    const dependencies = {} as InstallerDependencies;
    await expect(
      withBrowserAuthentication(dependencies, async () => {
        dependencies.applicationAuth?.(origin, "example-user");
        process.emit(signal);
        expect(() => dependencies.assertNotCancelled?.()).toThrow("cancelled");
        expect(() => dependencies.applicationAuth?.(origin, "example-user")).toThrow(
          "cancelled",
        );
      }),
    ).rejects.toThrow("cancelled");
    expect(close).toHaveBeenCalled();
  },
);

it("never starts a browser when the workflow selects an explicit bearer", async () => {
  const close = vi.spyOn(BrowserApplicationAuth.prototype, "close");
  const dependencies = {} as InstallerDependencies;
  dependencies.environment = { HARBOR_HF_CONTROL_BEARER_TOKEN: "explicit-test-bearer" };
  const listeners = process.listenerCount("SIGINT");
  await withBrowserAuthentication(dependencies, async () => {
    expect(dependencies.applicationAuth).toBeUndefined();
    expect(process.listenerCount("SIGINT")).toBe(listeners);
    return "bearer path";
  });
  expect(close).not.toHaveBeenCalled();
});
