import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  ContractValidationError,
  controlRecordPath,
  deterministicId,
  sandboxActionResultPath,
  sha256,
  validateCampaignSubmission,
  validateControlRecord,
  validatePreparedJobSubmission,
  validateResultCatalog,
  validateWorkerEvidenceManifest,
  workerEvidenceObjectPath,
} from "../src/index.js";

describe("canonical contracts", () => {
  it("encodes objects deterministically", () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: null } })).toBe(
      '{"a":{"b":null,"y":true},"z":1}\n',
    );
    expect(sha256(canonicalJson({ a: 1, b: 2 }))).toBe(
      sha256(canonicalJson({ b: 2, a: 1 })),
    );
    expect(deterministicId("action", "a", "b")).toBe(
      deterministicId("action", "a", "b"),
    );
    expect(canonicalJson({ metric: 1e-7, negative_zero: -0 })).toBe(
      '{"metric":1e-7,"negative_zero":0}\n',
    );
  });

  it("validates optional launch-policy campaign ceiling maximums", () => {
    const spec = {
      max_infrastructure_attempts: 2,
      reservation_microusd: 100_000,
      max_campaign_ceiling_microusd: 300_000_000,
      success_without_worker_receipt: false,
      publication_role: "diagnostic",
    };
    const profile = {
      schema_version: "v1",
      kind: "profile.object",
      record_id: "profile-launch-policy-cap",
      created_at: "2026-08-20T00:00:00.000Z",
      actor: { subject: "test", role: "service" },
      profile_kind: "launch_policy",
      name: "capped-policy",
      spec,
    };

    expect(validateControlRecord(profile)).toEqual(profile);
    const { max_campaign_ceiling_microusd: _maximum, ...historicalSpec } = spec;
    expect(validateControlRecord({ ...profile, spec: historicalSpec })).toMatchObject({
      spec: historicalSpec,
    });
    expect(
      validateControlRecord({
        ...profile,
        spec: { ...spec, max_campaign_ceiling_microusd: 0 },
      }),
    ).toMatchObject({ spec: { max_campaign_ceiling_microusd: 0 } });
    expect(
      validateControlRecord({
        ...profile,
        spec: { ...spec, max_campaign_ceiling_microusd: 1_000_000_000_000 },
      }),
    ).toMatchObject({ spec: { max_campaign_ceiling_microusd: 1_000_000_000_000 } });

    for (const invalid of [-1, 1.5, "300000000", 1_000_000_000_001]) {
      expect(() =>
        validateControlRecord({
          ...profile,
          spec: { ...spec, max_campaign_ceiling_microusd: invalid },
        }),
      ).toThrow(ContractValidationError);
    }
  });

  it("keeps Sandbox action result paths stable and scoped", () => {
    expect(sandboxActionResultPath("campaign-test", "action-test")).toBe(
      "sandbox-results/schema=v1/campaign-test/action-test/result.json",
    );
    expect(() => sandboxActionResultPath("../campaign", "action-test")).toThrow(
      "campaign_id is not a safe identifier",
    );
    expect(() => sandboxActionResultPath("campaign-test", "action/test")).toThrow(
      "action_id is not a safe identifier",
    );
  });

  it("validates scoped worker evidence manifests", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const path = workerEvidenceObjectPath(
      "campaign-test",
      "action-test",
      "task-test",
      digest,
    );
    const manifest = {
      schema_version: "v1",
      kind: "worker.evidence.manifest",
      campaign_id: "campaign-test",
      action_id: "action-test",
      task_id: "task-test",
      objects: [{ path, digest, size: 42 }],
    };
    expect(validateWorkerEvidenceManifest(manifest)).toEqual(manifest);
    expect(() =>
      validateWorkerEvidenceManifest({ ...manifest, undocumented: true }),
    ).toThrow(ContractValidationError);
  });

  it("validates bounded prepared Harbor job submissions", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const trial = {
      phase: "trial",
      task_id: "task-one-trial-1",
      source_task_id: "task-one",
      trial_index: 1,
      input_digest: digest,
      trial_lock: { schema_version: 2, task: { digest } },
      declared_image: "example.invalid/task:release",
      image: `example.invalid/task@${digest}`,
      cpus: 1,
      memory_mb: 2048,
      storage_mb: 10240,
      gpus: 0,
      agent_timeout_seconds: 900,
      verifier_timeout_seconds: 600,
      environment_build_timeout_seconds: 600,
      agent_setup_timeout_seconds: 360,
    };
    expect(validatePreparedJobSubmission(trial)).toEqual(trial);
    expect(() =>
      validatePreparedJobSubmission({ ...trial, benchmark_name: "special-case" }),
    ).toThrow(ContractValidationError);
  });

  it("rejects unknown durable fields", () => {
    expect(() =>
      validateControlRecord({
        schema_version: "v1",
        kind: "operator.acl",
        record_id: "acl-test",
        created_at: "2026-08-16T00:00:00Z",
        actor: { subject: "test", role: "operator" },
        operators: ["test"],
        readers: [],
        surprise: true,
      }),
    ).toThrow(ContractValidationError);
  });

  it("validates the immutable Job create dispatch fence", () => {
    const record = validateControlRecord({
      schema_version: "v1",
      kind: "action.dispatch",
      record_id: "action-dispatch-test",
      created_at: "2026-08-16T00:00:00Z",
      actor: { subject: "control", role: "service" },
      action_id: "action-test",
      campaign_id: "campaign-test",
      operation: "create",
      adoption_not_before: "2026-08-16T00:01:00Z",
    });
    expect(controlRecordPath(record)).toBe(
      "control/schema=v1/campaigns/campaign-test/actions/action-test/q-dispatch.json",
    );
  });

  it("validates fixed historical action dispositions", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const record = {
      schema_version: "v1",
      kind: "action.disposition",
      record_id: "disposition-action-test",
      created_at: "2026-08-21T00:00:00Z",
      actor: { subject: "operator", role: "operator" },
      campaign_id: "campaign-test",
      task_id: "task-test",
      action_id: "action-test",
      source_receipt_id: "receipt-action-test",
      source_receipt_digest: digest,
      close_action_id: "action-close-test",
      close_receipt_id: "receipt-close-test",
      close_receipt_digest: digest,
      batch_id: "disposition-batch-test",
      batch_digest: digest,
      batch_size: 2,
      effective_outcome: "failed",
      effective_observed_state: "AMBIGUOUS",
      effective_error_code: "sandbox_external_outcome_unknown",
      reason_code: "historical_non_replay_safe_command_ambiguity",
      reason: "correct a proved historical observation",
    } as const;

    expect(validateControlRecord(record)).toEqual(record);
    expect(controlRecordPath(record)).toBe(
      "control/schema=v1/campaigns/campaign-test/actions/action-test/zzz-disposition.json",
    );
    for (const changed of [
      { effective_outcome: "completed" },
      { effective_observed_state: "COMPLETED" },
      { effective_error_code: "another_error" },
      { reason_code: "operator_override" },
      { source_receipt_digest: "sha256:invalid" },
      { batch_size: 101 },
      { actor: { subject: "reader", role: "reader" } },
      { undocumented: true },
    ])
      expect(() => validateControlRecord({ ...record, ...changed })).toThrow(
        ContractValidationError,
      );
  });

  it("requires a reviewed root bootstrap for inference-enabled Sandboxes", () => {
    const sandbox = {
      image: `registry.example/sandbox@sha256:${"a".repeat(64)}`,
      hardware: "h200",
      timeout_seconds: 21_600,
      idle_timeout_seconds: 1_800,
      inference_token: "required",
      inference_upstream: "https://route.example.endpoints.huggingface.cloud/v1",
      inference_model: "example/model",
      inference_api: "chat-completions",
      inference_max_requests: 256,
      inference_max_concurrency: 1,
      inference_timeout_seconds: 1_800,
      inference_max_output_tokens: 32_768,
      reservation_microusd: 20_000_000,
      active_hourly_cost_microusd: 5_000_000,
      max_sandboxes: 1,
      max_commands: 128,
      max_command_seconds: 3_600,
      max_transfer_bytes: 1_048_576,
      allowed_roots: ["/app", "/logs"],
    };
    const intent = {
      schema_version: "v1",
      kind: "action.intent",
      record_id: "sandbox-action-test",
      created_at: "2026-08-18T00:00:00Z",
      actor: { subject: "control", role: "service" },
      action_id: "sandbox-action-test",
      campaign_id: "campaign-test",
      action_kind: "sandbox.create",
      generation: 0,
      target: "task-test",
      payload: { task_id: "task-test", sandbox },
    };
    expect(() => validateControlRecord(intent)).toThrow(ContractValidationError);
    expect(
      validateControlRecord({
        ...intent,
        payload: {
          task_id: "task-test",
          sandbox: {
            ...sandbox,
            root_bootstrap_command: ["/opt/worker/start-root-services"],
          },
        },
      }),
    ).toMatchObject({ kind: "action.intent", action_kind: "sandbox.create" });
    expect(
      validateControlRecord({
        schema_version: "v1",
        kind: "action.dispatch",
        record_id: "sandbox-dispatch-test",
        created_at: "2026-08-18T00:00:00Z",
        actor: { subject: "control", role: "service" },
        action_id: "sandbox-exec-test",
        campaign_id: "campaign-test",
        operation: "execute",
        adoption_not_before: "2026-08-18T00:01:00Z",
      }),
    ).toMatchObject({ operation: "execute" });
  });

  it("keeps profile and action payloads closed", () => {
    const base = {
      schema_version: "v1",
      record_id: "profile-test",
      created_at: "2026-08-16T00:00:00Z",
      actor: { subject: "test", role: "service" },
    };
    expect(() =>
      validateControlRecord({
        ...base,
        kind: "profile.object",
        profile_kind: "deployment",
        name: "test-deployment",
        spec: {
          route: "hf_job",
          models: ["model-one"],
          harnesses: ["harness-one"],
          job_image: "worker:latest",
          job_command: ["true"],
          hardware: "cpu-basic",
          timeout_seconds: 300,
        },
      }),
    ).toThrow(ContractValidationError);
    expect(() =>
      validateControlRecord({
        ...base,
        kind: "profile.object",
        profile_kind: "deployment",
        name: "untrusted-deployment",
        spec: {
          route: "hf_job",
          models: ["model-one"],
          harnesses: ["harness-one"],
          job_image: `worker@sha256:${"a".repeat(64)}`,
          job_command: ["true"],
          hardware: "cpu-basic",
          timeout_seconds: 300,
        },
      }),
    ).toThrow(ContractValidationError);
    const inferenceDeployment = {
      ...base,
      kind: "profile.object",
      profile_kind: "deployment",
      name: "inference-deployment",
      spec: {
        route: "hf_job",
        models: ["model-one"],
        harnesses: ["harness-one"],
        job_image: `worker@sha256:${"a".repeat(64)}`,
        job_command: ["true"],
        hardware: "cpu-basic",
        timeout_seconds: 300,
        trusted_worker: true,
        inference_token: "required",
        inference_max_requests: 64,
        inference_max_concurrency: 4,
        inference_timeout_seconds: 600,
        inference_max_output_tokens: 32768,
      },
    };
    expect(validateControlRecord(inferenceDeployment)).toEqual(inferenceDeployment);
    expect(() =>
      validateControlRecord({
        ...inferenceDeployment,
        spec: { ...inferenceDeployment.spec, inference_token: "optional" },
      }),
    ).toThrow(ContractValidationError);
    expect(() =>
      validateControlRecord({
        ...base,
        kind: "action.intent",
        record_id: "action-test",
        action_id: "action-test",
        campaign_id: "campaign-test",
        action_kind: "job.launch",
        generation: 0,
        target: "campaign",
        payload: { undocumented_provider_option: true },
      }),
    ).toThrow(ContractValidationError);
  });

  it("accepts imported profiles and real benchmark identifiers", () => {
    const profile = {
      schema_version: "v1",
      kind: "profile.object",
      record_id: "profile-imported-history",
      created_at: "2026-08-16T00:00:00Z",
      actor: { subject: "migration", role: "migration" },
      profile_kind: "deployment",
      name: "imported-history",
      spec: {
        route: "imported",
        models: ["model-one"],
        harnesses: ["pi"],
        source_campaign_ids: ["20260815T000000Z-source"],
        source_revisions: ["revision-one"],
      },
    };
    expect(validateControlRecord(profile)).toEqual(profile);
    expect(
      validateCampaignSubmission({
        benchmark: "shellbench-structured",
        model: "model-one",
        harness: "pi",
        launch_policy: "one-attempt",
        ceiling_microusd: 0,
        confirmed: true,
      }),
    ).toMatchObject({ harness: "pi" });
    expect(
      validateControlRecord({
        schema_version: "v1",
        kind: "campaign.lock",
        record_id: "lock-real-task-id",
        created_at: "2026-08-16T00:00:00Z",
        actor: { subject: "migration", role: "migration" },
        campaign_id: "campaign-real-task-id",
        profiles: [
          {
            kind: "benchmark",
            profile_id: `sha256:${"a".repeat(64)}`,
            name: "shellbench-structured",
            spec: {
              benchmark: "shellbench-structured",
              revision: "revision-one",
              task_ids: ["003fed-walnut-frame-apology"],
              task_digests: [`sha256:${"b".repeat(64)}`],
            },
          },
          {
            kind: "model",
            profile_id: `sha256:${"c".repeat(64)}`,
            name: "model-one",
            spec: { model_id: "example/model", revision: "revision-one" },
          },
          {
            kind: "harness",
            profile_id: `sha256:${"d".repeat(64)}`,
            name: "pi",
            spec: { agent: "pi", revision: "0.84.2", required_evidence: [] },
          },
          {
            kind: "deployment",
            profile_id: `sha256:${"e".repeat(64)}`,
            name: "imported-history",
            spec: profile.spec,
          },
          {
            kind: "launch_policy",
            profile_id: `sha256:${"f".repeat(64)}`,
            name: "one-attempt",
            spec: {
              max_infrastructure_attempts: 2,
              reservation_microusd: 0,
              success_without_worker_receipt: false,
              publication_role: "final",
            },
          },
        ],
        tasks: [
          {
            task_id: "003fed-walnut-frame-apology",
            input_digest: `sha256:${"b".repeat(64)}`,
          },
        ],
        ceiling_microusd: 0,
        source_revision: `sha256:${"0".repeat(64)}`,
      }),
    ).toMatchObject({ kind: "campaign.lock" });
  });

  it("validates result catalog entries", () => {
    const catalog = {
      schema_version: "v1",
      kind: "result.catalog",
      record_id: "catalog-test",
      created_at: "2026-08-16T00:00:00Z",
      source_digest: `sha256:${"a".repeat(64)}`,
      entries: [
        {
          publication_id: "publication-test",
          campaign_id: "campaign-test",
          run_id: null,
          published_at: "2026-08-16T00:00:00Z",
          benchmark: "benchmark-test",
          model: "model-test",
          harness: "harness-test",
          inference_provider: null,
          run_outcome: "complete",
          quality: "clean",
          publication_role: "final",
          task_count: 1,
          scored_task_count: 1,
          strict_pass_count: 1,
          primary_metric: { name: "mean_reward", value: 1, unit: "score" },
          result_path: "results/test.json",
        },
      ],
    };
    expect(validateResultCatalog(catalog)).toEqual(catalog);
    expect(() =>
      validateResultCatalog({
        ...catalog,
        entries: [{ ...catalog.entries[0], extra: 1 }],
      }),
    ).toThrow(ContractValidationError);
  });

  it("derives stable Bucket paths", () => {
    expect(
      controlRecordPath({
        kind: "action.intent",
        record_id: "action-1",
        campaign_id: "campaign-1",
        action_id: "action-1",
      }),
    ).toBe("control/schema=v1/campaigns/campaign-1/actions/action-1/intent.json");
    expect(
      controlRecordPath({
        kind: "action.advanced",
        record_id: "advanced-1",
        campaign_id: "campaign-1",
        action_id: "action-1",
      }),
    ).toBe("control/schema=v1/campaigns/campaign-1/actions/action-1/zz-advanced.json");
  });

  it("validates campaign submission boundaries", () => {
    expect(
      validateCampaignSubmission({
        benchmark: "control-smoke",
        model: "control-smoke",
        harness: "control-smoke",
        launch_policy: "control-smoke",
        ceiling_microusd: 0,
        confirmed: true,
      }),
    ).toMatchObject({ confirmed: true });
    expect(() =>
      validateCampaignSubmission({
        benchmark: "x",
        model: "x",
        harness: "x",
        launch_policy: "x",
        ceiling_microusd: -1,
        confirmed: false,
      }),
    ).toThrow(ContractValidationError);
  });
});
