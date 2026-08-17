import type { ActionIntent } from "@harbor-hf/contracts";
import {
  AmbiguousExternalActionError,
  type ExternalActionContext,
  ExternalActionNotFoundError,
  type ExternalActionPort,
  type ExternalActionResult,
  mintWorkerCapability,
} from "@harbor-hf/control-core";
import {
  cancelJob as cancelHfJob,
  getJob,
  listJobs,
  runJob,
  type SpaceHardwareFlavor,
} from "@huggingface/hub";

interface AdapterConfig {
  namespace: string;
  accessToken: string;
  inferenceToken?: string;
  controlUrl?: string;
  hubUrl?: string;
  endpointsUrl?: string;
}

function stringValue(intent: ActionIntent, key: keyof ActionIntent["payload"]): string {
  const value = intent.payload[key];
  if (typeof value !== "string")
    throw new Error(`action payload ${key} must be a string`);
  return value;
}

function numberValue(intent: ActionIntent, key: keyof ActionIntent["payload"]): number {
  const value = intent.payload[key];
  if (typeof value !== "number")
    throw new Error(`action payload ${key} must be a number`);
  return value;
}

function booleanValue(
  intent: ActionIntent,
  key: keyof ActionIntent["payload"],
  fallback = false,
): boolean {
  const value = intent.payload[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw new Error(`action payload ${key} must be a boolean`);
  return value;
}

function stringValues(
  intent: ActionIntent,
  key: keyof ActionIntent["payload"],
): string[] {
  const value = intent.payload[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`action payload ${key} must be an array of strings`);
  return value;
}

function inferenceTokenPolicy(intent: ActionIntent): "forbidden" | "required" {
  const value = intent.payload.inference_token ?? "forbidden";
  if (value !== "forbidden" && value !== "required")
    throw new Error("action payload inference_token is invalid");
  return value;
}

function verifyJobSecretNames(
  intent: ActionIntent,
  secretNames: string[] | undefined,
): void {
  const policy = inferenceTokenPolicy(intent);
  if (!secretNames) {
    if (policy === "required")
      throw new Error("required Job inference credential is not attested");
    return;
  }
  const expected = policy === "required" ? ["HF_INFERENCE_TOKEN"] : [];
  if (
    secretNames.length !== expected.length ||
    !secretNames.every((name, index) => name === expected[index])
  )
    throw new Error("Job secret names do not match the locked deployment");
}

function cleanFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "remote action failed";
  if (/token|authorization|cookie|secret/i.test(message))
    return "remote_dependency_error";
  return "remote_dependency_error";
}

function jobStateIsTerminal(state: string): boolean {
  return ["STOPPED", "COMPLETED", "CANCELLED", "CANCELED", "ERROR"].includes(
    state.toUpperCase(),
  );
}

function endpointStatus(raw: unknown): {
  state: string;
  ready_replicas: number | null;
} {
  if (!raw || typeof raw !== "object")
    return { state: "UNKNOWN", ready_replicas: null };
  const root = raw as Record<string, unknown>;
  const status =
    root.status && typeof root.status === "object"
      ? (root.status as Record<string, unknown>)
      : {};
  const state =
    typeof status.state === "string"
      ? status.state
      : typeof root.state === "string"
        ? root.state
        : "UNKNOWN";
  const replicas =
    root.replicas && typeof root.replicas === "object"
      ? (root.replicas as Record<string, unknown>)
      : {};
  const ready =
    typeof replicas.ready === "number"
      ? replicas.ready
      : typeof status.readyReplica === "number"
        ? status.readyReplica
        : null;
  return { state, ready_replicas: ready };
}

export class HuggingFaceActions implements ExternalActionPort {
  private readonly endpointsUrl: string;

  constructor(private readonly config: AdapterConfig) {
    if (config.inferenceToken && config.inferenceToken === config.accessToken)
      throw new Error("control and inference credentials must be distinct");
    this.endpointsUrl =
      config.endpointsUrl ?? "https://api.endpoints.huggingface.cloud/v2";
  }

  async execute(
    intent: ActionIntent,
    context?: ExternalActionContext,
  ): Promise<ExternalActionResult> {
    try {
      switch (intent.action_kind) {
        case "campaign.admit":
          return { outcome: "completed", observed_state: "admitted" };
        case "job.launch":
          return await this.launchJob(intent, context);
        case "job.observe":
          return await this.observeJob(intent);
        case "job.cancel":
          return await this.cancelJob(intent);
        case "endpoint.pause":
          return await this.endpointMutation(intent, "pause");
        case "endpoint.resume":
          return await this.endpointMutation(intent, "resume");
        case "campaign.cancel":
        case "publication.publish":
          return { outcome: "completed", observed_state: "handled_locally" };
      }
    } catch (error) {
      if (
        error instanceof AmbiguousExternalActionError ||
        error instanceof ExternalActionNotFoundError
      )
        throw error;
      if (intent.action_kind === "job.launch" && context?.adoption_only)
        throw new AmbiguousExternalActionError("Job adoption check failed", {
          cause: error,
        });
      return {
        outcome: "failed",
        observed_state: "ERROR",
        error_code: cleanFailure(error),
      };
    }
  }

  private async launchJob(
    intent: ActionIntent,
    context?: ExternalActionContext,
  ): Promise<ExternalActionResult> {
    const tokenPolicy = inferenceTokenPolicy(intent);
    if (tokenPolicy === "required" && !this.config.inferenceToken)
      throw new Error("required worker inference credential is unavailable");
    const inferenceEnvironment =
      tokenPolicy === "required"
        ? {
            HARBOR_HF_INFERENCE_MAX_REQUESTS: String(
              numberValue(intent, "inference_max_requests"),
            ),
            HARBOR_HF_INFERENCE_MAX_CONCURRENCY: String(
              numberValue(intent, "inference_max_concurrency"),
            ),
            HARBOR_HF_INFERENCE_TIMEOUT_SECONDS: String(
              numberValue(intent, "inference_timeout_seconds"),
            ),
            HARBOR_HF_INFERENCE_MAX_OUTPUT_TOKENS: String(
              numberValue(intent, "inference_max_output_tokens"),
            ),
          }
        : {};
    const jobs = await listJobs({
      namespace: this.config.namespace,
      accessToken: this.config.accessToken,
      ...(this.config.hubUrl ? { hubUrl: this.config.hubUrl } : {}),
    });
    const matches = jobs.filter(
      (job) => job.labels?.harbor_hf_action_id === intent.action_id,
    );
    if (matches.length > 1)
      throw new Error("multiple Jobs have the same deterministic action ID");
    if (matches.length === 1) {
      const job = matches[0];
      if (!job) throw new Error("matching Job disappeared");
      verifyJobSecretNames(intent, job.secrets);
      return {
        outcome: "adopted",
        observed_state: job.status.stage,
        resource_id: job.id,
      };
    }
    if (context?.adoption_only)
      throw new ExternalActionNotFoundError(
        "no Job has the deterministic action label",
      );
    if (!booleanValue(intent, "trusted_worker"))
      throw new Error("Job launch requires a trusted worker profile");
    if (!this.config.controlUrl)
      throw new Error("Job launch requires the control service URL");
    const timeoutSeconds = numberValue(intent, "timeout_seconds");
    const taskIds = stringValues(intent, "task_ids");
    const capability = mintWorkerCapability(this.config.accessToken, {
      namespace: this.config.namespace,
      campaign_id: intent.campaign_id,
      action_id: intent.action_id,
      task_ids: taskIds,
      expires_at: Math.floor(Date.now() / 1000) + timeoutSeconds + 3_600,
    });
    let job: Awaited<ReturnType<typeof runJob>>;
    try {
      job = await runJob({
        namespace: this.config.namespace,
        accessToken: this.config.accessToken,
        ...(this.config.hubUrl ? { hubUrl: this.config.hubUrl } : {}),
        dockerImage: stringValue(intent, "job_image"),
        command: stringValues(intent, "job_command"),
        flavor: stringValue(intent, "hardware") as SpaceHardwareFlavor,
        timeoutSeconds,
        attempts: 1,
        labels: {
          harbor_hf_action_id: intent.action_id,
          harbor_hf_campaign_id: intent.campaign_id,
        },
        environment: {
          HARBOR_HF_CAMPAIGN_ID: intent.campaign_id,
          HARBOR_HF_ACTION_ID: intent.action_id,
          HARBOR_HF_TASK_IDS_JSON: JSON.stringify(taskIds),
          HARBOR_HF_CONTROL_URL: this.config.controlUrl,
          HARBOR_HF_WORKER_CAPABILITY: capability,
          ...inferenceEnvironment,
        },
        ...(tokenPolicy === "required"
          ? { secrets: { HF_INFERENCE_TOKEN: this.config.inferenceToken as string } }
          : {}),
      });
      verifyJobSecretNames(intent, job.secrets);
    } catch (error) {
      throw new AmbiguousExternalActionError("Job launch outcome is ambiguous", {
        cause: error,
      });
    }
    return {
      outcome: "created",
      observed_state: job.status.stage,
      resource_id: job.id,
    };
  }

  private async observeJob(intent: ActionIntent): Promise<ExternalActionResult> {
    const remoteId = stringValue(intent, "resource_id");
    const job = await getJob({
      namespace: this.config.namespace,
      jobId: remoteId,
      accessToken: this.config.accessToken,
      ...(this.config.hubUrl ? { hubUrl: this.config.hubUrl } : {}),
    });
    verifyJobSecretNames(intent, job.secrets);
    if (job.labels?.harbor_hf_action_id !== intent.payload.launch_action_id)
      throw new Error("observed Job action label does not match the launch intent");
    return {
      outcome: "completed",
      observed_state: job.status.stage,
      resource_id: job.id,
    };
  }

  private async cancelJob(intent: ActionIntent): Promise<ExternalActionResult> {
    const remoteId = stringValue(intent, "resource_id");
    const options = {
      namespace: this.config.namespace,
      jobId: remoteId,
      accessToken: this.config.accessToken,
      ...(this.config.hubUrl ? { hubUrl: this.config.hubUrl } : {}),
    };
    let job: Awaited<ReturnType<typeof getJob>>;
    try {
      job = await cancelHfJob(options);
    } catch (error) {
      job = await getJob(options);
      if (!jobStateIsTerminal(job.status.stage)) throw error;
    }
    if (job.labels?.harbor_hf_action_id !== intent.payload.launch_action_id)
      throw new Error("cancelled Job action label does not match the launch intent");
    return {
      outcome: "completed",
      observed_state: job.status.stage,
      resource_id: job.id,
    };
  }

  private async endpointMutation(
    intent: ActionIntent,
    operation: "pause" | "resume",
  ): Promise<ExternalActionResult> {
    const endpointId = stringValue(intent, "endpoint_id");
    if (operation === "resume" && !booleanValue(intent, "watchdog_verified"))
      throw new Error("endpoint resume requires a verified cleanup watchdog");
    const response = await fetch(
      `${this.endpointsUrl}/endpoint/${encodeURIComponent(this.config.namespace)}/${encodeURIComponent(endpointId)}/${operation}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.accessToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      if (response.status !== 400)
        throw new Error(`endpoint ${operation} failed with ${response.status}`);
      const current = await this.getEndpoint(endpointId);
      const observed = endpointStatus(current);
      const alreadyDesired =
        operation === "pause"
          ? observed.state.toUpperCase().includes("PAUSED")
          : observed.state.toUpperCase().includes("RUNNING");
      if (!alreadyDesired)
        throw new Error(`endpoint ${operation} returned a non-idempotent conflict`);
      return {
        outcome: "adopted",
        observed_state: observed.state,
        resource_id: endpointId,
        ready_replicas: observed.ready_replicas,
      };
    }
    const raw = (await response.json()) as unknown;
    let observed = endpointStatus(raw);
    if (observed.ready_replicas === null)
      observed = endpointStatus(await this.getEndpoint(endpointId));
    return {
      outcome: "completed",
      observed_state: observed.state,
      resource_id: endpointId,
      ready_replicas: observed.ready_replicas,
    };
  }

  private async getEndpoint(endpointId: string): Promise<unknown> {
    const response = await fetch(
      `${this.endpointsUrl}/endpoint/${encodeURIComponent(this.config.namespace)}/${encodeURIComponent(endpointId)}`,
      {
        headers: { Authorization: `Bearer ${this.config.accessToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error(`endpoint observation failed with ${response.status}`);
    return response.json() as Promise<unknown>;
  }
}
