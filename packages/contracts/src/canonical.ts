import { createHash } from "node:crypto";

export class CanonicalJsonError extends Error {}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError("canonical JSON cannot contain a non-finite number");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, item]) => [key, normalize(item)]));
  }
  throw new CanonicalJsonError(`canonical JSON does not support ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(normalize(value))}\n`;
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function deterministicId(prefix: string, ...parts: readonly string[]): string {
  const digest = sha256(parts.join("\u0000")).slice(
    "sha256:".length,
    "sha256:".length + 24,
  );
  return `${prefix}-${digest}`;
}
