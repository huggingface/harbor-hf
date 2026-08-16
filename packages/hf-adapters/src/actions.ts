import type { ActionIntent } from "@harbor-hf/contracts";
import type { ExternalActionPort, ExternalActionResult } from "@harbor-hf/control-core";
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
  bucketId?: string;
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

function cleanFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "remote action failed";
  if (/token|authorization|cookie|secret/i.test(message))
    return "remote_dependency_error";
  return "remote_dependency_error";
}

function jobStateIsTerminal(state: string): boolean {
  return ["STOPPED", "COMPLETED", "CANCELLED", "CANCELED"].includes(
    state.toUpperCase(),
  );
}

function endpointStatus(raw: unknown): { state: string; ready_replicas: number } {
  if (!raw || typeof raw !== "object") return { state: "UNKNOWN", ready_replicas: 0 };
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
        : 0;
  return { state, ready_replicas: ready };
}

export class HuggingFaceActions implements ExternalActionPort {
  private readonly endpointsUrl: string;

  constructor(private readonly config: AdapterConfig) {
    this.endpointsUrl =
      config.endpointsUrl ?? "https://api.endpoints.huggingface.cloud/v2";
  }

  async execute(intent: ActionIntent): Promise<ExternalActionResult> {
    try {
      switch (intent.action_kind) {
        case "campaign.admit":
          return { outcome: "completed", observed_state: "admitted" };
        case "job.launch":
          return await this.launchJob(intent);
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
      return {
        outcome: "failed",
        observed_state: "ERROR",
        error_code: cleanFailure(error),
      };
    }
  }

  private async launchJob(intent: ActionIntent): Promise<ExternalActionResult> {
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
      return {
        outcome: "adopted",
        observed_state: job.status.stage,
        resource_id: job.id,
      };
    }
    const requiresToken = booleanValue(intent, "requires_hf_token");
    if (requiresToken && !booleanValue(intent, "trusted_worker"))
      throw new Error("HF_TOKEN may be passed only to a trusted worker profile");
    const volumes =
      this.config.bucketId && booleanValue(intent, "mount_bucket")
        ? [
            {
              source: { type: "bucket" as const, name: this.config.bucketId },
              mountPath: "/harbor-hf-bucket",
              readOnly: false,
            },
          ]
        : undefined;
    const job = await runJob({
      namespace: this.config.namespace,
      accessToken: this.config.accessToken,
      ...(this.config.hubUrl ? { hubUrl: this.config.hubUrl } : {}),
      dockerImage: stringValue(intent, "job_image"),
      command: stringValues(intent, "job_command"),
      flavor: stringValue(intent, "hardware") as SpaceHardwareFlavor,
      timeoutSeconds: numberValue(intent, "timeout_seconds"),
      attempts: 1,
      labels: {
        harbor_hf_action_id: intent.action_id,
        harbor_hf_campaign_id: intent.campaign_id,
      },
      environment: {
        HARBOR_HF_CAMPAIGN_ID: intent.campaign_id,
        HARBOR_HF_ACTION_ID: intent.action_id,
        HARBOR_HF_TASK_IDS_JSON: JSON.stringify(stringValues(intent, "task_ids")),
        ...(this.config.controlUrl
          ? { HARBOR_HF_CONTROL_URL: this.config.controlUrl }
          : {}),
        ...(this.config.bucketId ? { HARBOR_HF_BUCKET_ID: this.config.bucketId } : {}),
      },
      ...(requiresToken ? { secrets: { HF_TOKEN: this.config.accessToken } } : {}),
      ...(volumes ? { volumes } : {}),
    });
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
    const observed = endpointStatus(raw);
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
