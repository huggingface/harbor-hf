import { describe, expect, it } from "vitest";
import {
  ContractValidationError,
  InferenceBindingDenied,
  canonicalJson,
  harborJobResultPath,
  runId,
  runRecordPath,
  runStatePath,
  sha256,
  validateAgentPreset,
  validateAttemptCost,
  validateBenchmarkPreset,
  validateHarborJobConfig,
  validateRunRecord,
  validateRunState,
} from "../src/index.js";

const record = {
  schema_version: "v1",
  run_id: "run-0123456789abcdef01234567",
  created_at: "2026-09-04T00:00:00Z",
  submitted_by: "test-subject",
  role: "final",
  harbor_revision: "d".repeat(40),
  submission: {
    benchmark: { name: "terminal-bench-2-1", preset: "one-task-1-trial" },
    model: { id: "openai/model", provider: "provider", reasoning_effort: "off" },
    harness: { agent: "pi", version: "0.84.2" },
    cost_ceiling_usd: 0.25,
  },
  harbor_job_config: { n_attempts: 1, n_concurrent_trials: 1 },
} as const;

const state = {
  schema_version: "v1",
  run_id: record.run_id,
  revision: 0,
  updated_at: "2026-09-04T00:00:00Z",
  desired_state: "run",
  actor: "test-subject",
  parent_jobs: [],
} as const;

describe("contracts", () => {
  it("accepts absent or minimal recipe provenance, rejecting malformed and duplicate fields", () => {
    expect(validateRunRecord(record)).not.toHaveProperty("workbench_recipe");
    expect(
      validateRunRecord({ ...record, workbench_recipe: { name: "recipe-one" } })
        .workbench_recipe,
    ).toEqual({ name: "recipe-one" });
    for (const workbench_recipe of [
      null,
      {},
      { name: "" },
      { name: "<script>" },
      { name: "x".repeat(81) },
      { name: "recipe-one", revision_id: "duplicate" },
    ]) {
      expect(() => validateRunRecord({ ...record, workbench_recipe })).toThrow();
    }
  });

  it("encodes objects and run ids deterministically", () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: null } })).toBe(
      '{"a":{"b":null,"y":true},"z":1}\n',
    );
    expect(sha256(canonicalJson({ a: 1, b: 2 }))).toBe(
      sha256(canonicalJson({ b: 2, a: 1 })),
    );
    expect(runId("same-key")).toBe(runId("same-key"));
    expect(runId("same-key")).toMatch(/^run-[0-9a-f]{24}$/);
    expect(() => runId("  ")).toThrow("idempotency key");
  });

  it("builds the three run paths", () => {
    expect(runRecordPath(record.run_id)).toBe(
      `${record.run_id.replace(/^/, "runs/")}/run.json`,
    );
    expect(runStatePath(record.run_id)).toBe(`runs/${record.run_id}/state.json`);
    expect(harborJobResultPath(record.run_id)).toBe(
      `runs/${record.run_id}/job/result.json`,
    );
  });

  it("validates current and legacy stored cost ceilings", () => {
    expect(validateRunRecord(record)).toEqual(record);
    const legacy = {
      ...record,
      submission: {
        ...record.submission,
        cost_ceiling_usd: undefined,
        cost_ceiling_usd_per_trial: 0.25,
      },
    };
    expect(validateRunRecord(legacy)).toEqual(legacy);
    expect(() =>
      validateRunRecord({
        ...record,
        submission: {
          ...record.submission,
          cost_ceiling_usd_per_trial: 0.25,
        },
      }),
    ).toThrow(ContractValidationError);
    expect(() =>
      validateRunRecord({
        ...record,
        submission: {
          benchmark: record.submission.benchmark,
          model: record.submission.model,
          harness: record.submission.harness,
        },
      }),
    ).toThrow(ContractValidationError);
  });

  it("validates stored records and rejects unknown fields", () => {
    expect(validateRunRecord(record)).toEqual(record);
    expect(validateRunState(state)).toEqual(state);
    expect(() => validateRunRecord({ ...record, extra: true })).toThrow(
      ContractValidationError,
    );
    expect(() => validateRunState({ ...state, desired_state: "stop" })).toThrow(
      ContractValidationError,
    );
  });

  it("validates reviewed presets", () => {
    const preset = {
      schema_version: "v1",
      benchmark: "terminal-bench-2-1",
      preset: "one-task-1-trial",
      leaderboard_eligible: false,
      job: {
        datasets: [{ repo: "https://example.test/repo.git@revision", path: "tasks" }],
        n_attempts: 1,
        n_concurrent_trials: 1,
        environment: {
          type: "hf-sandbox",
          kwargs: { flavor: "cpu-upgrade", job_timeout: "none" },
        },
      },
    } as const;
    expect(validateBenchmarkPreset(preset)).toMatchObject({
      job: { environment: preset.job.environment },
    });
    expect(() =>
      validateBenchmarkPreset({
        ...preset,
        job: { ...preset.job, environment_flavor: "cpu-upgrade" },
      }),
    ).toThrow(ContractValidationError);
    expect(
      validateAgentPreset({
        schema_version: "v1",
        agent: "pi",
        version: "0.84.2",
        harbor_agent: { name: "pi", kwargs: { version: "0.84.2" } },
        reasoning_option: "thinking",
        reasoning_values: ["off", "high"],
      }),
    ).toMatchObject({ agent: "pi" });
  });

  it("validates durable attempt cost receipts", () => {
    const receipt = {
      schema_version: "v1",
      attempt_id: "11111111-1111-4111-8111-111111111111",
      trial_name: "task__trial",
      cost_usd: 0.2,
    } as const;
    expect(validateAttemptCost(receipt)).toEqual(receipt);
    expect(() => validateAttemptCost({ ...receipt, extra: true })).toThrow(
      ContractValidationError,
    );
    expect(() => validateAttemptCost({ ...receipt, cost_usd: -1 })).toThrow(
      ContractValidationError,
    );
  });

  it("uses the pinned Harbor JobConfig schema", () => {
    expect(
      validateHarborJobConfig({ n_attempts: 1, n_concurrent_trials: 1 }),
    ).toMatchObject({
      n_attempts: 1,
    });
    expect(() => validateHarborJobConfig({ n_concurrent_trials: 0 })).toThrow(
      ContractValidationError,
    );
  });
});

it("shares a fixed pre-transport inference denial contract without diagnostic payloads", () => {
  const denied = new InferenceBindingDenied();
  expect(denied).toBeInstanceOf(Error);
  expect(denied.message).toBe(
    "Inference binding is unavailable or not reviewed for this execution",
  );
  expect(JSON.stringify(denied)).toBe("{}");
  for (const message of [
    "Inference credential presence is unavailable",
    "Selected inference credential is missing",
  ] as const) {
    expect(new InferenceBindingDenied(message).message).toBe(message);
  }
});
