import type { CapacityProfileSpec } from "@harbor-hf/contracts";

export type SandboxLimitingFactor =
  | "campaign_cancelled"
  | "campaign_sandbox_capacity"
  | "namespace_sandbox_capacity"
  | "hardware_sandbox_capacity"
  | "provider_request_capacity"
  | "sandbox_start_rate"
  | "campaign_budget";

export type SandboxAdmissionDecision =
  | {
      outcome: "admitted";
      tokens_remaining: number;
      refill_cursor_at: string;
    }
  | {
      outcome: "deferred";
      limiting_factor: Exclude<
        SandboxLimitingFactor,
        "campaign_cancelled" | "campaign_budget"
      >;
      not_before: string | null;
    }
  | {
      outcome: "rejected";
      limiting_factor: "campaign_cancelled" | "campaign_budget";
    };

export interface SandboxAdmissionSnapshot {
  campaign_active_sandboxes: number;
  namespace_active_sandboxes: number;
  hardware_active_sandboxes: number;
  campaign_reserved_provider_requests: number;
  tokens_remaining: number | null;
  refill_cursor_at: string | null;
  cancellation_requested: boolean;
  budget_available: boolean;
}

export interface SandboxAdmissionRequest {
  now: string;
  campaign_max_sandboxes: number;
  hardware: string;
  reserved_provider_requests: number;
  campaign_max_provider_requests: number;
  capacity: CapacityProfileSpec;
}

interface TokenState {
  tokens: number;
  cursor: number;
}

function tokenState(
  profile: CapacityProfileSpec,
  snapshot: SandboxAdmissionSnapshot,
  now: number,
): TokenState {
  const previousCursor = snapshot.refill_cursor_at
    ? Date.parse(snapshot.refill_cursor_at)
    : now;
  const cursor = Math.min(previousCursor, now);
  const starting = Math.min(
    profile.start_burst,
    snapshot.tokens_remaining ?? profile.start_burst,
  );
  const periodMs = profile.start_refill_period_seconds * 1000;
  const periods = Math.max(0, Math.floor((now - cursor) / periodMs));
  return {
    tokens: Math.min(
      profile.start_burst,
      starting + periods * profile.start_refill_tokens,
    ),
    cursor: cursor + periods * periodMs,
  };
}

export function decideSandboxAdmission(
  request: SandboxAdmissionRequest,
  snapshot: SandboxAdmissionSnapshot,
): SandboxAdmissionDecision {
  if (snapshot.cancellation_requested)
    return { outcome: "rejected", limiting_factor: "campaign_cancelled" };
  if (!snapshot.budget_available)
    return { outcome: "rejected", limiting_factor: "campaign_budget" };
  if (snapshot.campaign_active_sandboxes >= request.campaign_max_sandboxes)
    return {
      outcome: "deferred",
      limiting_factor: "campaign_sandbox_capacity",
      not_before: null,
    };
  if (snapshot.namespace_active_sandboxes >= request.capacity.max_active_sandboxes)
    return {
      outcome: "deferred",
      limiting_factor: "namespace_sandbox_capacity",
      not_before: null,
    };
  const hardwareMaximum = request.capacity.hardware_limits.find(
    (limit) => limit.hardware === request.hardware,
  )?.max_active_sandboxes;
  if (
    hardwareMaximum !== undefined &&
    snapshot.hardware_active_sandboxes >= hardwareMaximum
  )
    return {
      outcome: "deferred",
      limiting_factor: "hardware_sandbox_capacity",
      not_before: null,
    };
  if (
    snapshot.campaign_reserved_provider_requests + request.reserved_provider_requests >
    request.campaign_max_provider_requests
  )
    return {
      outcome: "deferred",
      limiting_factor: "provider_request_capacity",
      not_before: null,
    };
  const now = Date.parse(request.now);
  const state = tokenState(request.capacity, snapshot, now);
  if (state.tokens < 1)
    return {
      outcome: "deferred",
      limiting_factor: "sandbox_start_rate",
      not_before: new Date(
        state.cursor + request.capacity.start_refill_period_seconds * 1000,
      ).toISOString(),
    };
  return {
    outcome: "admitted",
    tokens_remaining: state.tokens - 1,
    refill_cursor_at: new Date(state.cursor).toISOString(),
  };
}
