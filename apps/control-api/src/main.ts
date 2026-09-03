import { buildApp, warmResultItems } from "./app.js";
import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";

const config = loadConfig();
const runtime = await createRuntime(config);
const app = await buildApp(runtime);
let closing = false;

function errorDetails(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: "unknown failure" };
}

async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down");
  await app.close();
  await runtime.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  // Listen before the Bucket projection rebuild. Hugging Face marks the
  // Space unhealthy if port 7860 stays closed for 30 minutes, and a full
  // rebuild of the live store now exceeds that window.
  await app.listen({
    host:
      config.node_env === "development" && config.auth_mode === "development"
        ? "127.0.0.1"
        : "0.0.0.0",
    port: config.port,
  });
  await runtime.initialize();
  void warmResultItems(runtime).catch((error: unknown) => {
    app.log.warn(
      { error_name: error instanceof Error ? error.name : "Error" },
      "result catalog cache warm failed",
    );
  });
  runtime.start((error) => {
    app.log.error({ err: errorDetails(error) }, "reconciler tick failed");
  });
} catch (error) {
  app.log.error({ err: errorDetails(error) }, "control startup failed");
  await Promise.allSettled([app.close(), runtime.close()]);
  process.exitCode = 1;
}
