import { spawn } from "node:child_process";

const commands = [
  ["npm", ["run", "dev:api"]],
  ["npm", ["run", "dev:web"]],
] as const;

const children = commands.map(([command, args]) =>
  spawn(command, args, {
    stdio: "inherit",
    env: process.env,
    detached: true,
  }),
);

let stopping = false;

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
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
  (child) =>
    new Promise<number>((resolvePromise) => {
      child.once("error", () => resolvePromise(1));
      child.once("exit", (code) => resolvePromise(code ?? 1));
    }),
);

const exitCode = await Promise.race(exits);
stop("SIGTERM");
await Promise.allSettled(exits);
process.exitCode = exitCode;
