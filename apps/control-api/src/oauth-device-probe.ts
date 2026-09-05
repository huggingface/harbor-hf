import type { AppConfig } from "./config.js";

const endpoint = "https://huggingface.co/oauth/device";
const errors = [
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "invalid_request",
  "access_denied",
] as const;
type OAuthError = (typeof errors)[number];
export type ProbeResult =
  | "accepted"
  | `rejected:${OAuthError | "unknown"}`
  | "transporterror"
  | "invalidresponse"
  | "disabled"
  | "invalidwindow"
  | "invalidconfig";

let attempted = false;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("missing body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 32 * 1024) throw new Error("body limit");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function classify(response: Response, body: unknown): ProbeResult {
  if (!record(body)) return "invalidresponse";
  if (!response.ok) {
    const category = errors.find((error) => body.error === error) ?? "unknown";
    return `rejected:${category}`;
  }
  if (
    !["device_code", "user_code", "verification_uri"].every(
      (field) => typeof body[field] === "string" && body[field].length > 0,
    ) ||
    typeof body.expires_in !== "number" ||
    !Number.isInteger(body.expires_in) ||
    body.expires_in <= 0
  )
    return "invalidresponse";
  return "accepted";
}

/** Startup diagnostic only. Restarts can repeat issuance before the fixed expiry. */
export async function probeDeviceEligibility(
  config: AppConfig,
  until: string | undefined,
  request: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<ProbeResult | null> {
  if (attempted) return null;
  attempted = true;
  if (!until) return "disabled";
  const remaining = Date.parse(until) - now();
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(until) ||
    !Number.isFinite(remaining) ||
    remaining <= 0 ||
    remaining > 10 * 60 * 1000
  )
    return "invalidwindow";
  if (
    config.node_env !== "production" ||
    config.write_mode !== "disabled" ||
    config.auth_mode !== "oauth" ||
    !config.oauth ||
    !["https://huggingface.co", "https://huggingface.co/"].includes(config.oauth.issuer)
  )
    return "invalidconfig";
  try {
    // OAuth client credentials are read from the existing server config only.
    // Never use either HF persistent token, log exceptions, or return body data.
    const response = await request(endpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Basic ${Buffer.from(
          `${encodeURIComponent(config.oauth.client_id)}:${encodeURIComponent(config.oauth.client_secret)}`,
        ).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: "scope=openid+profile",
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return "invalidresponse";
    }
    try {
      return classify(response, await boundedJson(response));
    } catch {
      return "invalidresponse";
    }
  } catch {
    return "transporterror";
  }
}
