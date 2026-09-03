import { resolve } from "node:path";
import type { ParentHardware } from "@harbor-hf/hf-adapters";
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
  HARBOR_HF_PRESETS_ROOT: z.string().min(1).default("./presets"),
  HARBOR_HF_MAX_ACTIVE_JOBS: z.coerce.number().int().min(1).max(1024).default(16),
  HARBOR_HF_PARENT_IMAGE: z.string().optional(),
  HARBOR_HF_PARENT_HARDWARE: z.string().default("cpu-basic"),
  HARBOR_HF_PARENT_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(86_400)
    .default(86_400),
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
    .min(1_000)
    .max(300_000)
    .default(15_000),
  HARBOR_HF_PARENT_RESTART_DELAY_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3_600_000)
    .default(60_000),
  HARBOR_HF_SOURCE_REVISION: z.string().min(7).max(160).default("development"),
  HARBOR_HF_WORKBENCH_RUNNER: z.enum(["disabled", "docker", "hf-jobs"]).optional(),
  HARBOR_HF_WORKBENCH_IMAGE: z.string().min(1).max(1024).default("python:3.12-slim"),
  HARBOR_HF_BOOTSTRAP_OPERATOR_SUBJECTS: z.string().default(""),
});

interface OAuthConfig {
  issuer: string;
  client_id: string;
  client_secret: string;
  scopes: string;
  callback_url: string;
  session_ttl_seconds: number;
}

export interface AppConfig {
  node_env: "development" | "test" | "production";
  port: number;
  namespace: string;
  bucket_id: string;
  bucket_root: string;
  store_mode: "bucket" | "filesystem";
  projection_path: string;
  auth_path: string;
  presets_root: string;
  max_active_jobs: number;
  parent_image: string | null;
  parent_hardware: ParentHardware;
  parent_timeout_seconds: number;
  web_root: string;
  auth_mode: "oauth" | "development";
  write_mode: "disabled" | "enabled";
  public_origin: string;
  oauth: OAuthConfig | null;
  hf_token: string | null;
  hf_inference_token: string | null;
  reconcile_interval_ms: number;
  parent_restart_delay_ms: number;
  source_revision: string;
  workbench_runner: "disabled" | "docker" | "hf-jobs";
  workbench_image: string;
  bootstrap_operator_subjects: string[];
}

function normalizePublicOrigin(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("public origin must contain only an HTTP or HTTPS origin");
  return url.origin;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(environment);
  const storeMode =
    parsed.HARBOR_HF_STORE_MODE ??
    (parsed.NODE_ENV === "test" ? "filesystem" : "bucket");
  if (parsed.HARBOR_HF_WRITE_MODE === "enabled") {
    if (!parsed.HF_TOKEN || !parsed.HF_INFERENCE_TOKEN)
      throw new Error("write-enabled service requires both approved credentials");
    if (!parsed.HARBOR_HF_PARENT_IMAGE)
      throw new Error("write-enabled service requires HARBOR_HF_PARENT_IMAGE");
    if (!/@sha256:[0-9a-f]{64}$/.test(parsed.HARBOR_HF_PARENT_IMAGE))
      throw new Error("parent image must use an immutable digest");
  }
  if (parsed.HARBOR_HF_WORKBENCH_RUNNER === "hf-jobs" && !parsed.HF_TOKEN) {
    throw new Error("Hugging Face Workbench Jobs require HF_TOKEN");
  }
  if (
    parsed.HF_TOKEN &&
    parsed.HF_INFERENCE_TOKEN &&
    parsed.HF_TOKEN === parsed.HF_INFERENCE_TOKEN
  )
    throw new Error("control and inference credentials must be distinct");
  const publicOrigin = normalizePublicOrigin(
    parsed.HARBOR_HF_PUBLIC_ORIGIN ??
      (parsed.SPACE_HOST
        ? `https://${parsed.SPACE_HOST}`
        : `http://127.0.0.1:${parsed.PORT}`),
  );
  let oauth: OAuthConfig | null = null;
  if (parsed.HARBOR_HF_AUTH_MODE === "oauth") {
    if (
      !parsed.OAUTH_CLIENT_ID ||
      !parsed.OAUTH_CLIENT_SECRET ||
      !parsed.OPENID_PROVIDER_URL
    )
      throw new Error("OAuth mode requires the Hugging Face OIDC environment");
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
    presets_root: resolve(parsed.HARBOR_HF_PRESETS_ROOT),
    max_active_jobs: parsed.HARBOR_HF_MAX_ACTIVE_JOBS,
    parent_image: parsed.HARBOR_HF_PARENT_IMAGE ?? null,
    parent_hardware: parsed.HARBOR_HF_PARENT_HARDWARE as ParentHardware,
    parent_timeout_seconds: parsed.HARBOR_HF_PARENT_TIMEOUT_SECONDS,
    web_root: resolve(parsed.HARBOR_HF_WEB_ROOT),
    auth_mode: parsed.HARBOR_HF_AUTH_MODE,
    write_mode: parsed.HARBOR_HF_WRITE_MODE,
    public_origin: publicOrigin,
    oauth,
    hf_token: parsed.HF_TOKEN ?? null,
    hf_inference_token: parsed.HF_INFERENCE_TOKEN ?? null,
    reconcile_interval_ms: parsed.HARBOR_HF_RECONCILE_INTERVAL_MS,
    parent_restart_delay_ms: parsed.HARBOR_HF_PARENT_RESTART_DELAY_MS,
    source_revision: parsed.HARBOR_HF_SOURCE_REVISION,
    workbench_runner:
      parsed.HARBOR_HF_WORKBENCH_RUNNER ??
      (parsed.NODE_ENV === "development" ? "docker" : "disabled"),
    workbench_image: parsed.HARBOR_HF_WORKBENCH_IMAGE,
    bootstrap_operator_subjects: parsed.HARBOR_HF_BOOTSTRAP_OPERATOR_SUBJECTS.split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  };
}
