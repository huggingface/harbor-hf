import { createHmac } from "node:crypto";
import type { ActionIntent, SandboxPolicy } from "@harbor-hf/contracts";
import {
  AmbiguousExternalActionError,
  type ExternalActionContext,
  ExternalActionNotFoundError,
  type ExternalActionResult,
} from "@harbor-hf/control-core";
import { cancelJob, getJob, listJobs } from "@huggingface/hub";

const sandboxPort = 49_983;
const serverMount = "/.hf-sbx-server";
const serverBucket = "huggingface/sbx-server";

export interface SandboxGatewayConfig {
  namespace: string;
  accessToken: string;
  inferenceToken?: string;
  hubUrl?: string;
}

export interface SandboxExecResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  signal: number | null;
  timed_out: boolean;
  duration_ms: number;
}

export interface SandboxReadResult {
  bytes: Uint8Array;
  digest?: string;
}

interface RawJob {
  id: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt?: string | null;
  dockerImage?: string | null;
  flavor?: string | { name?: string } | null;
  labels?: Record<string, string> | null;
  secrets?: string[] | null;
  status?: {
    stage?: string;
    exposeUrls?: string[] | null;
  };
}

function value(intent: ActionIntent, key: keyof ActionIntent["payload"]): unknown {
  return intent.payload[key];
}

function stringValue(intent: ActionIntent, key: keyof ActionIntent["payload"]): string {
  const item = value(intent, key);
  if (typeof item !== "string" || !item)
    throw new Error(`sandbox action payload ${key} must be a string`);
  return item;
}

function numberValue(intent: ActionIntent, key: keyof ActionIntent["payload"]): number {
  const item = value(intent, key);
  if (typeof item !== "number" || !Number.isSafeInteger(item))
    throw new Error(`sandbox action payload ${key} must be an integer`);
  return item;
}

function commandValue(intent: ActionIntent): [string, ...string[]] {
  const item = value(intent, "command");
  if (
    !Array.isArray(item) ||
    item.length === 0 ||
    !item.every((part) => typeof part === "string")
  )
    throw new Error("sandbox command must be a non-empty string array");
  return item as [string, ...string[]];
}

function policyValue(intent: ActionIntent): SandboxPolicy {
  const item = value(intent, "sandbox");
  if (!item || typeof item !== "object" || Array.isArray(item))
    throw new Error("sandbox action requires an immutable sandbox policy");
  return item as SandboxPolicy;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function bootstrapScript(policy: SandboxPolicy): string {
  const bootstrap = policy.root_bootstrap_command?.length
    ? `${policy.root_bootstrap_command.map(shellQuote).join(" ")}\n`
    : "";
  return [
    "set -eu",
    "cp /.hf-sbx-server/sbx-server /tmp/.sbx-server",
    "chmod 0700 /tmp/.sbx-server",
    bootstrap.trimEnd(),
    "unset HF_INFERENCE_TOKEN HARBOR_HF_INFERENCE_UPSTREAM HARBOR_HF_INFERENCE_ALLOWED_MODEL HARBOR_HF_INFERENCE_API HARBOR_HF_INFERENCE_MAX_REQUESTS HARBOR_HF_INFERENCE_MAX_CONCURRENCY HARBOR_HF_INFERENCE_TIMEOUT_SECONDS HARBOR_HF_INFERENCE_MAX_OUTPUT_TOKENS",
    "exec /tmp/.sbx-server",
  ]
    .filter(Boolean)
    .join("\n");
}

function sandboxNonce(actionId: string): string {
  return createHmac("sha256", "harbor-hf-sandbox-nonce")
    .update(actionId)
    .digest("hex")
    .slice(0, 32);
}

function sandboxToken(accessToken: string, nonce: string): string {
  return createHmac("sha256", accessToken).update(`hf-sandbox:${nonce}`).digest("hex");
}

function expectedSecrets(policy: SandboxPolicy): string[] {
  return policy.inference_token === "required"
    ? ["HF_INFERENCE_TOKEN", "SBX_TOKEN"]
    : ["SBX_TOKEN"];
}

function verifySecrets(job: RawJob, policy: SandboxPolicy): void {
  const observed = [...(job.secrets ?? [])].sort();
  const expected = expectedSecrets(policy);
  if (
    observed.length !== expected.length ||
    !observed.every((name, index) => name === expected[index])
  )
    throw new Error("Sandbox Job secret names do not match immutable policy");
}

function verifySpec(job: RawJob, policy: SandboxPolicy): void {
  const flavor =
    typeof job.flavor === "string" ? job.flavor : (job.flavor?.name ?? null);
  if (job.dockerImage !== policy.image || flavor !== policy.hardware)
    throw new Error("Sandbox Job image or hardware does not match immutable policy");
}

function verifyLabels(job: RawJob, intent: ActionIntent): void {
  if (
    job.labels?.harbor_hf_sandbox_action_id !==
      (intent.action_kind === "sandbox.create"
        ? intent.action_id
        : intent.payload.sandbox_create_action_id) ||
    job.labels?.harbor_hf_campaign_id !== intent.campaign_id ||
    job.labels?.harbor_hf_task_id !== intent.payload.task_id
  )
    throw new Error("Sandbox Job labels do not match the durable action");
}

function verifiedProxyUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    !/^[a-z0-9-]+--49983\.hf\.jobs$/.test(url.hostname) ||
    (url.pathname !== "/" && !url.pathname.startsWith("/scopes/")) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("Sandbox Job proxy URL is not an approved scoped HF host");
  return value.replace(/\/$/, "");
}

function jobState(job: RawJob): string {
  return job.status?.stage ?? "UNKNOWN";
}

function observedCostMicrousd(job: RawJob, policy: SandboxPolicy): number {
  const started = Date.parse(job.startedAt ?? "");
  const finished = Date.parse(job.finishedAt ?? job.updatedAt ?? "");
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started)
    return policy.reservation_microusd;
  return Math.ceil(
    ((finished - started) / 1000 / 3600) * policy.active_hourly_cost_microusd,
  );
}

function isTerminal(state: string): boolean {
  return new Set([
    "COMPLETED",
    "STOPPED",
    "ERROR",
    "DELETED",
    "CANCELED",
    "CANCELLED",
  ]).has(state.toUpperCase());
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error("Sandbox response exceeds immutable transfer limit");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export class HuggingFaceSandboxGateway {
  constructor(private readonly config: SandboxGatewayConfig) {
    if (config.inferenceToken && config.inferenceToken === config.accessToken)
      throw new Error("control and inference credentials must be distinct");
  }

  async lifecycle(
    intent: ActionIntent,
    context?: ExternalActionContext,
  ): Promise<ExternalActionResult> {
    switch (intent.action_kind) {
      case "sandbox.create":
        return this.create(intent, context);
      case "sandbox.observe":
        return this.observe(intent);
      case "sandbox.close":
        return this.close(intent);
      default:
        throw new Error("sandbox data actions require the worker API");
    }
  }

  async execute(intent: ActionIntent): Promise<SandboxExecResult> {
    const policy = policyValue(intent);
    const command = commandValue(intent);
    const timeout = numberValue(intent, "timeout_seconds");
    if (timeout > policy.max_command_seconds)
      throw new Error("sandbox command timeout exceeds immutable policy");
    const response = await this.request(intent, "/v1/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cmd: command,
        shell: false,
        cwd: stringValue(intent, "cwd"),
        timeout,
      }),
    });
    const bytes = await readBounded(response, policy.max_transfer_bytes);
    const lines = new TextDecoder().decode(bytes).split("\n");
    let stdout = "";
    let stderr = "";
    let result: SandboxExecResult | null = null;
    for (const line of lines) {
      if (!line) continue;
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.event === "stdout" && typeof event.data === "string")
        stdout += event.data;
      else if (event.event === "stderr" && typeof event.data === "string")
        stderr += event.data;
      else if (event.event === "exit")
        result = {
          exit_code: typeof event.exit_code === "number" ? event.exit_code : null,
          stdout,
          stderr,
          signal: typeof event.signal === "number" ? event.signal : null,
          timed_out: event.timed_out === true,
          duration_ms: typeof event.duration_ms === "number" ? event.duration_ms : 0,
        };
    }
    if (!result) throw new Error("Sandbox command stream ended without an exit event");
    return result;
  }

  async write(intent: ActionIntent, bytes: Uint8Array): Promise<void> {
    const policy = policyValue(intent);
    if (bytes.byteLength !== numberValue(intent, "content_size"))
      throw new Error("sandbox write size does not match the durable action");
    if (bytes.byteLength > policy.max_transfer_bytes)
      throw new Error("sandbox write exceeds immutable transfer limit");
    const params = new URLSearchParams({ path: stringValue(intent, "path") });
    const mode = intent.payload.mode;
    if (typeof mode === "string") params.set("mode", mode);
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    await this.request(intent, `/v1/files/write?${params.toString()}`, {
      method: "PUT",
      body,
    });
  }

  async read(intent: ActionIntent): Promise<SandboxReadResult> {
    const policy = policyValue(intent);
    const params = new URLSearchParams({ path: stringValue(intent, "path") });
    const response = await this.request(intent, `/v1/files/read?${params.toString()}`, {
      method: "GET",
    });
    return { bytes: await readBounded(response, policy.max_transfer_bytes) };
  }

  private async create(
    intent: ActionIntent,
    context?: ExternalActionContext,
  ): Promise<ExternalActionResult> {
    const policy = policyValue(intent);
    if (policy.inference_token === "required" && !this.config.inferenceToken)
      throw new Error("required Sandbox inference credential is unavailable");
    const jobs = await listJobs({
      namespace: this.config.namespace,
      accessToken: this.config.accessToken,
      ...(this.config.hubUrl ? { hubUrl: this.config.hubUrl } : {}),
    });
    const matches = jobs.filter(
      (job) => job.labels?.harbor_hf_sandbox_action_id === intent.action_id,
    ) as RawJob[];
    if (matches.length > 1)
      throw new Error("multiple Sandbox Jobs have the same deterministic action ID");
    if (matches.length === 1) {
      const job = matches[0] as RawJob;
      verifyLabels(job, intent);
      verifySecrets(job, policy);
      verifySpec(job, policy);
      return {
        outcome: "adopted",
        observed_state: jobState(job),
        resource_id: job.id,
      };
    }
    if (context?.adoption_only)
      throw new ExternalActionNotFoundError(
        "no Sandbox Job has the deterministic action label",
      );
    const nonce = sandboxNonce(intent.action_id);
    const token = sandboxToken(this.config.accessToken, nonce);
    const environment: Record<string, string> = {
      SBX_PORT: String(sandboxPort),
      SBX_IDLE_TIMEOUT: String(policy.idle_timeout_seconds),
    };
    if (policy.inference_token === "required") {
      environment.HARBOR_HF_INFERENCE_UPSTREAM = policy.inference_upstream as string;
      environment.HARBOR_HF_INFERENCE_ALLOWED_MODEL = policy.inference_model as string;
      environment.HARBOR_HF_INFERENCE_API = policy.inference_api as string;
      environment.HARBOR_HF_INFERENCE_MAX_REQUESTS = String(
        policy.inference_max_requests,
      );
      environment.HARBOR_HF_INFERENCE_MAX_CONCURRENCY = String(
        policy.inference_max_concurrency,
      );
      environment.HARBOR_HF_INFERENCE_TIMEOUT_SECONDS = String(
        policy.inference_timeout_seconds,
      );
      environment.HARBOR_HF_INFERENCE_MAX_OUTPUT_TOKENS = String(
        policy.inference_max_output_tokens,
      );
    }
    const secrets: Record<string, string> = { SBX_TOKEN: token };
    if (policy.inference_token === "required")
      secrets.HF_INFERENCE_TOKEN = this.config.inferenceToken as string;
    let job: RawJob;
    try {
      const response = await fetch(
        `${this.config.hubUrl ?? "https://huggingface.co"}/api/jobs/${encodeURIComponent(this.config.namespace)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            dockerImage: policy.image,
            command: ["/bin/sh", "-c", bootstrapScript(policy)],
            arguments: [],
            environment,
            secrets,
            flavor: policy.hardware,
            timeoutSeconds: policy.timeout_seconds,
            attempts: 1,
            labels: {
              "hf-sandbox": "1",
              "hf-sandbox-mode": "dedicated",
              "hf-sandbox-nonce": nonce,
              harbor_hf_sandbox_action_id: intent.action_id,
              harbor_hf_campaign_id: intent.campaign_id,
              harbor_hf_task_id: stringValue(intent, "task_id"),
            },
            volumes: [
              {
                type: "bucket",
                source: serverBucket,
                mountPath: serverMount,
                readOnly: true,
              },
            ],
            expose: { ports: [sandboxPort] },
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok)
        throw new Error(`Sandbox Job create failed with ${response.status}`);
      job = (await response.json()) as RawJob;
      verifyLabels(job, intent);
      verifySecrets(job, policy);
      verifySpec(job, policy);
    } catch (error) {
      throw new AmbiguousExternalActionError(
        "Sandbox Job launch outcome is ambiguous",
        { cause: error },
      );
    }
    return {
      outcome: "created",
      observed_state: jobState(job),
      resource_id: job.id,
    };
  }

  private async observe(intent: ActionIntent): Promise<ExternalActionResult> {
    const job = (await getJob({
      namespace: this.config.namespace,
      jobId: stringValue(intent, "resource_id"),
      accessToken: this.config.accessToken,
      ...(this.config.hubUrl ? { hubUrl: this.config.hubUrl } : {}),
    })) as RawJob;
    verifyLabels(job, intent);
    verifySecrets(job, policyValue(intent));
    verifySpec(job, policyValue(intent));
    const state = jobState(job);
    return {
      outcome: "completed",
      observed_state:
        state.toUpperCase() === "RUNNING" && !(await this.proxyReady(job))
          ? "STARTING"
          : state,
      resource_id: job.id,
    };
  }

  private async proxyReady(job: RawJob): Promise<boolean> {
    const baseUrl = job.status?.exposeUrls?.find((url) =>
      url.includes(`--${sandboxPort}.`),
    );
    if (!baseUrl) return false;
    const proxyUrl = verifiedProxyUrl(baseUrl);
    try {
      const response = await fetch(`${proxyUrl}/health`, {
        headers: { Authorization: `Bearer ${this.config.accessToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return false;
      const bytes = await readBounded(response, 4_096);
      const health = JSON.parse(new TextDecoder().decode(bytes)) as Record<
        string,
        unknown
      >;
      return health.status === "ok" && typeof health.version === "string";
    } catch {
      return false;
    }
  }

  private async close(intent: ActionIntent): Promise<ExternalActionResult> {
    const jobId = stringValue(intent, "resource_id");
    const options = {
      namespace: this.config.namespace,
      jobId,
      accessToken: this.config.accessToken,
      ...(this.config.hubUrl ? { hubUrl: this.config.hubUrl } : {}),
    };
    try {
      await cancelJob(options);
    } catch (error) {
      const observed = (await getJob(options)) as RawJob;
      if (!isTerminal(jobState(observed))) throw error;
    }
    const job = (await getJob(options)) as RawJob;
    verifyLabels(job, intent);
    const policy = policyValue(intent);
    verifySpec(job, policy);
    const state = jobState(job);
    if (!isTerminal(state))
      throw new AmbiguousExternalActionError(
        "Sandbox shutdown is still pending remote termination",
      );
    return {
      outcome: "completed",
      observed_state: state,
      resource_id: job.id,
      cost_microusd: observedCostMicrousd(job, policy),
    };
  }

  private async request(
    intent: ActionIntent,
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const job = await this.rawJob(stringValue(intent, "resource_id"));
    verifyLabels(job, intent);
    verifySecrets(job, policyValue(intent));
    verifySpec(job, policyValue(intent));
    if (jobState(job).toUpperCase() !== "RUNNING")
      throw new Error("Sandbox Job is not running");
    const baseUrl = job.status?.exposeUrls?.find((url) =>
      url.includes(`--${sandboxPort}.`),
    );
    if (!baseUrl) throw new Error("Sandbox Job proxy is not ready");
    const proxyUrl = verifiedProxyUrl(baseUrl);
    const nonce = job.labels?.["hf-sandbox-nonce"];
    if (!nonce) throw new Error("Sandbox Job nonce is missing");
    const response = await fetch(`${proxyUrl}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${this.config.accessToken}`,
        "X-Sandbox-Token": sandboxToken(this.config.accessToken, nonce),
      },
      signal: AbortSignal.timeout(policyValue(intent).max_command_seconds * 1_000),
    });
    if (!response.ok)
      throw new Error(`Sandbox API request failed with ${response.status}`);
    return response;
  }

  private async rawJob(jobId: string): Promise<RawJob> {
    const response = await fetch(
      `${this.config.hubUrl ?? "https://huggingface.co"}/api/jobs/${encodeURIComponent(this.config.namespace)}/${encodeURIComponent(jobId)}`,
      {
        headers: { Authorization: `Bearer ${this.config.accessToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error(`Sandbox Job observation failed with ${response.status}`);
    return (await response.json()) as RawJob;
  }
}
