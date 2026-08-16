import { createHash } from "node:crypto";

export { CanonicalJsonError, canonicalJson } from "./canonical-json.mjs";

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
