import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "@harbor-hf/contracts";

export interface WorkerCapability {
  version: 1;
  namespace: string;
  campaign_id: string;
  action_id: string;
  task_ids: string[];
  expires_at: number;
}

function signature(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(`v1.${body}`).digest();
}

export function mintWorkerCapability(
  secret: string,
  capability: Omit<WorkerCapability, "version">,
): string {
  if (!secret) throw new Error("worker capability secret is missing");
  const value: WorkerCapability = {
    version: 1,
    ...capability,
    task_ids: [...new Set(capability.task_ids)].sort(),
  };
  const body = Buffer.from(canonicalJson(value), "utf8").toString("base64url");
  return `v1.${body}.${signature(secret, body).toString("base64url")}`;
}

export function verifyWorkerCapability(
  secret: string,
  token: string,
  namespace: string,
  now = Date.now(),
): WorkerCapability | null {
  if (!secret || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const body = parts[1];
  const encodedSignature = parts[2];
  if (!body || !encodedSignature) return null;
  let provided: Buffer;
  let value: unknown;
  try {
    provided = Buffer.from(encodedSignature, "base64url");
    value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const expected = signature(secret, body);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
    return null;
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<WorkerCapability>;
  if (
    candidate.version !== 1 ||
    candidate.namespace !== namespace ||
    typeof candidate.campaign_id !== "string" ||
    typeof candidate.action_id !== "string" ||
    !Array.isArray(candidate.task_ids) ||
    candidate.task_ids.length === 0 ||
    !candidate.task_ids.every((task) => typeof task === "string") ||
    new Set(candidate.task_ids).size !== candidate.task_ids.length ||
    typeof candidate.expires_at !== "number" ||
    !Number.isSafeInteger(candidate.expires_at) ||
    candidate.expires_at < Math.floor(now / 1000)
  )
    return null;
  return candidate as WorkerCapability;
}
