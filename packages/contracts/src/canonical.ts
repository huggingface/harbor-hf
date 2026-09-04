import { createHash } from "node:crypto";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonical(value))}\n`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function deterministicId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}-${sha256(parts.join("\u0000")).slice(0, 24)}`;
}

export function runId(idempotencyKey: string): string {
  if (!idempotencyKey.trim()) throw new Error("idempotency key is required");
  return `run-${sha256(idempotencyKey).slice(0, 24)}`;
}
