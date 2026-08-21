import type { ActionIntent, CapacityProfileSpec } from "@harbor-hf/contracts";
import { describe, expect, it } from "vitest";
import { fairSandboxCreateOrder } from "../src/reconciler.js";
import {
  decideSandboxAdmission,
  type SandboxAdmissionSnapshot,
} from "../src/sandbox-admission.js";

const capacity: CapacityProfileSpec = {
  namespace: "test",
  max_active_sandboxes: 4,
  hardware_limits: [{ hardware: "cpu-basic", max_active_sandboxes: 2 }],
  start_burst: 2,
  start_refill_tokens: 1,
  start_refill_period_seconds: 10,
};

const snapshot: SandboxAdmissionSnapshot = {
  campaign_active_sandboxes: 0,
  namespace_active_sandboxes: 0,
  hardware_active_sandboxes: 0,
  campaign_reserved_provider_requests: 0,
  tokens_remaining: null,
  refill_cursor_at: null,
  cancellation_requested: false,
  budget_available: true,
};

const request = {
  now: "2026-08-22T00:00:00.000Z",
  campaign_max_sandboxes: 3,
  hardware: "cpu-basic",
  reserved_provider_requests: 1,
  campaign_max_provider_requests: 2,
  capacity,
};

function createIntent(
  campaignId: string,
  task: string,
  createdAt: string,
): ActionIntent {
  return {
    schema_version: "v1",
    kind: "action.intent",
    record_id: `action-${campaignId}-${task}`,
    created_at: createdAt,
    actor: { subject: "test", role: "service" },
    action_id: `action-${campaignId}-${task}`,
    campaign_id: campaignId,
    action_kind: "sandbox.create",
    generation: 0,
    target: task,
    payload: { task_id: task },
  };
}

describe("Sandbox admission", () => {
  it("round-robins campaigns while preserving FIFO inside each campaign", () => {
    const intents = [
      createIntent("campaign-a", "task-1", "2026-08-22T00:00:00.000Z"),
      createIntent("campaign-a", "task-2", "2026-08-22T00:00:01.000Z"),
      createIntent("campaign-b", "task-1", "2026-08-22T00:00:02.000Z"),
      createIntent("campaign-b", "task-2", "2026-08-22T00:00:03.000Z"),
    ];

    expect(
      fairSandboxCreateOrder(intents, "campaign-a").map(
        (intent) => `${intent.campaign_id}:${intent.payload.task_id}`,
      ),
    ).toEqual([
      "campaign-b:task-1",
      "campaign-a:task-1",
      "campaign-b:task-2",
      "campaign-a:task-2",
    ]);
  });

  it("admits within every independent limit", () => {
    expect(decideSandboxAdmission(request, snapshot)).toEqual({
      outcome: "admitted",
      tokens_remaining: 1,
      refill_cursor_at: request.now,
    });
  });

  it.each([
    [{ campaign_active_sandboxes: 3 }, "campaign_sandbox_capacity"],
    [{ namespace_active_sandboxes: 4 }, "namespace_sandbox_capacity"],
    [{ hardware_active_sandboxes: 2 }, "hardware_sandbox_capacity"],
    [{ campaign_reserved_provider_requests: 2 }, "provider_request_capacity"],
  ] as const)("defers when %s reaches its limit", (change, limitingFactor) => {
    expect(decideSandboxAdmission(request, { ...snapshot, ...change })).toEqual({
      outcome: "deferred",
      limiting_factor: limitingFactor,
      not_before: null,
    });
  });

  it("returns a factual token refill time", () => {
    expect(
      decideSandboxAdmission(request, {
        ...snapshot,
        tokens_remaining: 0,
        refill_cursor_at: request.now,
      }),
    ).toEqual({
      outcome: "deferred",
      limiting_factor: "sandbox_start_rate",
      not_before: "2026-08-22T00:00:10.000Z",
    });
  });

  it("refills integer tokens without moving a future cursor backward", () => {
    expect(
      decideSandboxAdmission(
        { ...request, now: "2026-08-22T00:00:25.000Z" },
        {
          ...snapshot,
          tokens_remaining: 0,
          refill_cursor_at: request.now,
        },
      ),
    ).toEqual({
      outcome: "admitted",
      tokens_remaining: 1,
      refill_cursor_at: "2026-08-22T00:00:20.000Z",
    });
    expect(
      decideSandboxAdmission(request, {
        ...snapshot,
        tokens_remaining: 0,
        refill_cursor_at: "2026-08-22T00:01:00.000Z",
      }),
    ).toEqual({
      outcome: "deferred",
      limiting_factor: "sandbox_start_rate",
      not_before: "2026-08-22T00:00:10.000Z",
    });
  });

  it("rejects cancellation and budget failure before capacity", () => {
    expect(
      decideSandboxAdmission(request, {
        ...snapshot,
        cancellation_requested: true,
        campaign_active_sandboxes: 3,
      }),
    ).toEqual({
      outcome: "rejected",
      limiting_factor: "campaign_cancelled",
    });
    expect(
      decideSandboxAdmission(request, { ...snapshot, budget_available: false }),
    ).toEqual({ outcome: "rejected", limiting_factor: "campaign_budget" });
  });
});
