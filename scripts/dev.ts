import { spawn } from "node:child_process";

if (process.env.NODE_ENV && process.env.NODE_ENV !== "development")
  throw new Error("npm run dev refuses a non-development NODE_ENV");
if (
  process.env.HARBOR_HF_AUTH_MODE &&
  process.env.HARBOR_HF_AUTH_MODE !== "development"
)
  throw new Error("npm run dev refuses OAuth authentication");

const commands = [
  ["API", "npm", ["run", "dev:api"]],
  ["web", "npm", ["run", "dev:web"]],
] as const;

console.error("Harbor-HF development console: http://127.0.0.1:5173");
console.error("Local state: .harbor-hf/ (ignored by Git)");

const children = commands.map(([label, command, args]) => ({
  label,
  child: spawn(command, args, {
    stdio: "inherit",
    env: process.env,
    detached: true,
  }),
}));

let stopping = false;

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) {
    if (!child.pid) continue;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

const exits = children.map(
  ({ child, label }) =>
    new Promise<number>((resolvePromise) => {
      child.once("error", (error) => {
        console.error(`${label} development process failed to start: ${error.message}`);
        resolvePromise(1);
      });
      child.once("exit", (code, signal) => {
        const result = code ?? (signal ? 1 : 0);
        if (!stopping)
          console.error(
            `${label} development process stopped (${signal ?? `exit ${result}`})`,
          );
        resolvePromise(result);
      });
    }),
);

const exitCode = await Promise.race(exits);
stop("SIGTERM");
await Promise.allSettled(exits);
process.exitCode = exitCode;
