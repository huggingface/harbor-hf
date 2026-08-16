import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";

const config = loadConfig();
const runtime = await createRuntime(config);
const app = await buildApp(runtime);
let closing = false;

async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down");
  await app.close();
  await runtime.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: "0.0.0.0", port: config.port });
runtime.initialize().catch((error: unknown) => {
  app.log.error(
    {
      err:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: "Error", message: "initialization failed" },
    },
    "control initialization failed",
  );
});
