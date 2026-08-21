import { resolve } from "node:path";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  PORT: z.coerce.number().int().min(1).max(65535).default(7860),
  HARBOR_HF_NAMESPACE: z.string().min(1).max(160),
  HARBOR_HF_BUCKET_ID: z.string().min(3).max(320),
  HARBOR_HF_BUCKET_ROOT: z.string().min(1).default("/data"),
  HARBOR_HF_STORE_MODE: z.enum(["bucket", "filesystem"]).optional(),
  HARBOR_HF_PROJECTION_PATH: z.string().min(1).default("/tmp/harbor-hf/control.sqlite"),
  HARBOR_HF_AUTH_PATH: z.string().min(1).default("/tmp/harbor-hf/auth.sqlite"),
  HARBOR_HF_PROFILES_ROOT: z.string().min(1).default("./profiles"),
  HARBOR_HF_WEB_ROOT: z.string().min(1).default("./apps/control-web/dist"),
  HARBOR_HF_AUTH_MODE: z.enum(["oauth", "development"]).default("oauth"),
  HARBOR_HF_WRITE_MODE: z.enum(["disabled", "enabled"]).default("disabled"),
  HARBOR_HF_PUBLIC_ORIGIN: z.string().url().optional(),
  SPACE_HOST: z.string().min(1).optional(),
  OAUTH_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  OAUTH_SCOPES: z.string().min(1).default("openid profile"),
  OPENID_PROVIDER_URL: z.string().url().optional(),
  HF_TOKEN: z.string().min(8).optional(),
  HF_INFERENCE_TOKEN: z.string().min(8).optional(),
  HARBOR_HF_RECONCILE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60000)
    .default(2000),
  HARBOR_HF_OBSERVE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(300000)
    .default(5000),
  HARBOR_HF_WORKER_RECEIPT_GRACE_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(300000)
    .default(60000),
  HARBOR_HF_SOURCE_REVISION: z.string().min(7).max(160).default("development"),
  HARBOR_HF_BOOTSTRAP_OPERATOR_SUBJECTS: z.string().default(""),
});

export interface AppConfig {
  node_env: "development" | "test" | "production";
  port: number;
  namespace: string;
  bucket_id: string;
  bucket_root: string;
  store_mode: "bucket" | "filesystem";
  projection_path: string;
  auth_path: string;
  profiles_root: string;
  web_root: string;
  auth_mode: "oauth" | "development";
  write_mode: "disabled" | "enabled";
  public_origin: string;
  oauth: {
    issuer: string;
    client_id: string;
    client_secret: string;
    scopes: string;
    callback_url: string;
    session_ttl_seconds: number;
  } | null;
  hf_token: string | null;
  hf_inference_token: string | null;
  reconcile_interval_ms: number;
  observe_interval_ms: number;
  worker_receipt_grace_ms: number;
  source_revision: string;
  bootstrap_operator_subjects: string[];
}

function normalizePublicOrigin(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("public origin must contain only an HTTP or HTTPS origin");
  return url.origin;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(environment);
  if (parsed.NODE_ENV === "production" && parsed.HARBOR_HF_AUTH_MODE !== "oauth") {
    throw new Error("production requires OAuth authentication");
  }
  const storeMode =
    parsed.HARBOR_HF_STORE_MODE ??
    (parsed.NODE_ENV === "production" ? "bucket" : "filesystem");
  if (storeMode === "bucket" && !parsed.HF_TOKEN) {
    throw new Error("Bucket-backed service requires HF_TOKEN");
  }
  if (parsed.HARBOR_HF_WRITE_MODE !== "disabled" && !parsed.HF_TOKEN) {
    throw new Error("write-enabled service requires HF_TOKEN");
  }
  if (
    parsed.HF_TOKEN &&
    parsed.HF_INFERENCE_TOKEN &&
    parsed.HF_TOKEN === parsed.HF_INFERENCE_TOKEN
  ) {
    throw new Error("control and inference credentials must be distinct");
  }
  const publicOrigin = normalizePublicOrigin(
    parsed.HARBOR_HF_PUBLIC_ORIGIN ??
      (parsed.SPACE_HOST
        ? `https://${parsed.SPACE_HOST}`
        : `http://127.0.0.1:${parsed.PORT}`),
  );
  let oauth: AppConfig["oauth"] = null;
  if (parsed.HARBOR_HF_AUTH_MODE === "oauth") {
    if (
      !parsed.OAUTH_CLIENT_ID ||
      !parsed.OAUTH_CLIENT_SECRET ||
      !parsed.OPENID_PROVIDER_URL
    ) {
      throw new Error("OAuth mode requires the Hugging Face OIDC environment");
    }
    oauth = {
      issuer: parsed.OPENID_PROVIDER_URL,
      client_id: parsed.OAUTH_CLIENT_ID,
      client_secret: parsed.OAUTH_CLIENT_SECRET,
      scopes: parsed.OAUTH_SCOPES,
      callback_url: `${publicOrigin}/auth/callback`,
      session_ttl_seconds: 12 * 60 * 60,
    };
  }
  return {
    node_env: parsed.NODE_ENV,
    port: parsed.PORT,
    namespace: parsed.HARBOR_HF_NAMESPACE,
    bucket_id: parsed.HARBOR_HF_BUCKET_ID,
    bucket_root: resolve(parsed.HARBOR_HF_BUCKET_ROOT),
    store_mode: storeMode,
    projection_path: resolve(parsed.HARBOR_HF_PROJECTION_PATH),
    auth_path: resolve(parsed.HARBOR_HF_AUTH_PATH),
    profiles_root: resolve(parsed.HARBOR_HF_PROFILES_ROOT),
    web_root: resolve(parsed.HARBOR_HF_WEB_ROOT),
    auth_mode: parsed.HARBOR_HF_AUTH_MODE,
    write_mode: parsed.HARBOR_HF_WRITE_MODE,
    public_origin: publicOrigin,
    oauth,
    hf_token: parsed.HF_TOKEN ?? null,
    hf_inference_token: parsed.HF_INFERENCE_TOKEN ?? null,
    reconcile_interval_ms: parsed.HARBOR_HF_RECONCILE_INTERVAL_MS,
    observe_interval_ms: parsed.HARBOR_HF_OBSERVE_INTERVAL_MS,
    worker_receipt_grace_ms: parsed.HARBOR_HF_WORKER_RECEIPT_GRACE_MS,
    source_revision: parsed.HARBOR_HF_SOURCE_REVISION,
    bootstrap_operator_subjects: parsed.HARBOR_HF_BOOTSTRAP_OPERATOR_SUBJECTS.split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  };
}
