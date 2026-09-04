import { type ApplicationAuthAdapter, BrowserApplicationAuth } from "./browser-auth.js";
import type { InstallerDependencies } from "./workflow.js";

/** Keep the browser alive across a Space restart, but never across commands. */
export async function withBrowserAuthentication<T>(
  dependencies: InstallerDependencies,
  action: () => Promise<T>,
): Promise<T> {
  // Explicit automation keeps its existing signal behavior; no browser is used.
  if ((dependencies.environment ?? process.env).HARBOR_HF_CONTROL_BEARER_TOKEN)
    return action();
  let adapter: ApplicationAuthAdapter | undefined;
  let binding: string | undefined;
  let cancelled = false;
  const previous = dependencies.applicationAuth;
  const previousCheck = dependencies.assertNotCancelled;
  dependencies.assertNotCancelled = () => {
    previousCheck?.();
    if (cancelled) throw new Error("Browser verification cancelled");
  };
  dependencies.applicationAuth = (origin, username) => {
    if (cancelled) throw new Error("Browser verification cancelled");
    const requested = JSON.stringify([origin, username]);
    if (binding && binding !== requested)
      throw new Error("Browser authentication binding changed");
    binding = requested;
    adapter ??= new BrowserApplicationAuth(origin, username, {
      progress: () =>
        process.stderr.write(
          "Sign in in the opened browser as the planned operator.\n",
        ),
    });
    return adapter;
  };
  const cancel = () => {
    cancelled = true;
    void adapter?.close();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  process.once("SIGHUP", cancel);
  try {
    const result = await action();
    if (cancelled) throw new Error("Browser verification cancelled");
    return result;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGHUP", cancel);
    if (previousCheck) dependencies.assertNotCancelled = previousCheck;
    else delete dependencies.assertNotCancelled;
    if (previous) dependencies.applicationAuth = previous;
    else delete dependencies.applicationAuth;
    await adapter?.close();
  }
}
