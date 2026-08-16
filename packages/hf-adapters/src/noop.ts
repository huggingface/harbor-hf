import type { ActionIntent } from "@harbor-hf/contracts";
import type { ExternalActionPort, ExternalActionResult } from "@harbor-hf/control-core";

export class NoopActions implements ExternalActionPort {
  private readonly jobs = new Map<string, { id: string; observations: number }>();

  async execute(intent: ActionIntent): Promise<ExternalActionResult> {
    if (intent.action_kind === "job.launch") {
      const existing = this.jobs.get(intent.action_id);
      if (existing)
        return {
          outcome: "adopted",
          observed_state: "RUNNING",
          resource_id: existing.id,
        };
      const id = `job-${intent.action_id.slice(-16)}`;
      this.jobs.set(intent.action_id, { id, observations: 0 });
      return { outcome: "created", observed_state: "RUNNING", resource_id: id };
    }
    if (intent.action_kind === "job.observe") {
      const launchActionId = String(intent.payload.launch_action_id);
      const job = this.jobs.get(launchActionId);
      if (!job)
        return {
          outcome: "failed",
          observed_state: "ERROR",
          error_code: "job_not_found",
        };
      job.observations += 1;
      return { outcome: "completed", observed_state: "STOPPED", resource_id: job.id };
    }
    if (intent.action_kind === "endpoint.pause") {
      return {
        outcome: "completed",
        observed_state: "PAUSED",
        resource_id: String(intent.payload.endpoint_id),
        ready_replicas: 0,
      };
    }
    if (intent.action_kind === "endpoint.resume") {
      return {
        outcome: "completed",
        observed_state: "RUNNING",
        resource_id: String(intent.payload.endpoint_id),
        ready_replicas: 1,
      };
    }
    return { outcome: "completed", observed_state: "completed" };
  }
}
