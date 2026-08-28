import { describe, expect, it } from "vitest";
import {
  ContractValidationError,
  canonicalJson,
  controlRecordPath,
  deterministicId,
  schemas,
  sha256,
  validateRunSubmission,
  validateControlRecord,
  validateLeaderboardSnapshot,
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

  it("validates optional launch-policy run ceiling maximums", () => {
    const spec = {
      max_infrastructure_attempts: 2,
      reservation_microusd: 100_000,
      max_run_ceiling_microusd: 300_000_000,
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
    const { max_run_ceiling_microusd: _maximum, ...historicalSpec } = spec;
    expect(validateControlRecord({ ...profile, spec: historicalSpec })).toMatchObject({
      spec: historicalSpec,
    });
    expect(
      validateControlRecord({
        ...profile,
        spec: { ...spec, max_run_ceiling_microusd: 0 },
      }),
    ).toMatchObject({ spec: { max_run_ceiling_microusd: 0 } });
    expect(
      validateControlRecord({
        ...profile,
        spec: { ...spec, max_run_ceiling_microusd: 1_000_000_000_000 },
      }),
    ).toMatchObject({ spec: { max_run_ceiling_microusd: 1_000_000_000_000 } });

    for (const invalid of [-1, 1.5, "300000000", 1_000_000_000_001]) {
      expect(() =>
        validateControlRecord({
          ...profile,
          spec: { ...spec, max_run_ceiling_microusd: invalid },
        }),
      ).toThrow(ContractValidationError);
    }
  });

  it("validates scoped worker evidence manifests", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const path = workerEvidenceObjectPath(
      "run-test",
      "action-test",
      "task-test",
      digest,
    );
    const manifest = {
      schema_version: "v1",
      kind: "worker.evidence.manifest",
      run_id: "run-test",
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
      trial_lock_digest: digest,
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
      run_id: "run-test",
      operation: "create",
      adoption_not_before: "2026-08-16T00:01:00Z",
    });
    expect(controlRecordPath(record)).toBe(
      "control/schema=v1/runs/run-test/actions/action-test/q-dispatch.json",
    );
  });

  it("validates service capacity profiles and Job capacity records", () => {
    const profile = {
      schema_version: "v1",
      kind: "profile.object",
      record_id: "profile-capacity-test",
      created_at: "2026-08-22T00:00:00.000Z",
      actor: { subject: "test", role: "service" },
      profile_kind: "capacity",
      name: "capacity-test",
      spec: {
        namespace: "test",
        max_active_jobs: 8,
        hardware_limits: [{ hardware: "cpu-basic", max_active_jobs: 4 }],
        start_burst: 2,
        start_refill_tokens: 1,
        start_refill_period_seconds: 10,
      },
    } as const;
    const grant = {
      schema_version: "v1",
      kind: "job.admission",
      record_id: "job-admission-test",
      created_at: "2026-08-22T00:00:01.000Z",
      actor: { subject: "control", role: "service" },
      action_id: "job-action-test",
      run_id: "run-test",
      namespace: "test",
      capacity_profile_id: `sha256:${"a".repeat(64)}`,
      hardware: "cpu-basic",
      reserved_provider_requests: 1,
      tokens_remaining: 1,
      refill_cursor_at: "2026-08-22T00:00:00.000Z",
      previous_grant_id: null,
    } as const;
    const release = {
      schema_version: "v1",
      kind: "job.capacity-release",
      record_id: "job-capacity-release-test",
      created_at: "2026-08-22T00:01:00.000Z",
      actor: { subject: "control", role: "service" },
      action_id: "job-action-test",
      run_id: "run-test",
      grant_id: grant.record_id,
      release_reason: "job_terminal",
      evidence_record_id: "receipt-test",
    } as const;

    expect(validateControlRecord(profile)).toEqual(profile);
    expect(validateControlRecord(grant)).toEqual(grant);
    expect(validateControlRecord(release)).toEqual(release);
    expect(controlRecordPath(grant)).toContain("/p-admission.json");
    expect(controlRecordPath(release)).toContain("/zy-capacity-release.json");
    expect(() =>
      validateControlRecord({
        ...profile,
        spec: { ...profile.spec, start_burst: 0 },
      }),
    ).toThrow(ContractValidationError);
  });

  it("does not expose a Sandbox contract or action kind", () => {
    expect(JSON.stringify(schemas.controlRecord).toLowerCase()).not.toContain(
      "sandbox",
    );
    expect(() =>
      validateControlRecord({
        schema_version: "v1",
        kind: "action.intent",
        record_id: "obsolete-action-test",
        created_at: "2026-08-18T00:00:00Z",
        actor: { subject: "control", role: "service" },
        action_id: "obsolete-action-test",
        run_id: "run-test",
        action_kind: "sandbox.create",
        generation: 0,
        target: "task-test",
        payload: { task_id: "task-test" },
      }),
    ).toThrow(ContractValidationError);
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
          contract_version: "v1",
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
          contract_version: "v1",
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
        contract_version: "v1",
        route: "hf_job",
        models: ["model-one"],
        harnesses: ["harness-one"],
        job_image: `worker@sha256:${"a".repeat(64)}`,
        job_command: ["true"],
        hardware: "cpu-basic",
        timeout_seconds: 300,
        trusted_worker: true,
        inference_token: "required",
        inference_upstream: "https://router.huggingface.co/v1",
        inference_api: "chat-completions",
        inference_max_requests: 64,
        inference_max_concurrency: 4,
        inference_timeout_seconds: 600,
        inference_max_output_tokens: 32768,
        inference_provider: "provider",
        input_price_microusd_per_million_tokens: 100_000,
        output_price_microusd_per_million_tokens: 200_000,
        cache_read_price_microusd_per_million_tokens: 100_000,
        cache_write_price_microusd_per_million_tokens: 100_000,
        context_window: 131_072,
        harbor_version: "0.21.0",
        worker_revision: "abcdef0",
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
        run_id: "run-test",
        action_kind: "job.launch",
        generation: 0,
        target: "run",
        payload: { undocumented_provider_option: true },
      }),
    ).toThrow(ContractValidationError);
  });

  it("rejects model-owned data in active harness profiles", () => {
    const profile = {
      schema_version: "v1",
      kind: "profile.object",
      record_id: "profile-reusable-harness",
      created_at: "2026-08-28T00:00:00Z",
      actor: { subject: "test", role: "service" },
      profile_kind: "harness",
      name: "reusable-harness",
      spec: {
        contract_version: "v1",
        agent: "example-agent",
        revision: "1.0.0",
        required_evidence: ["workspace"],
        capabilities: { inference_apis: ["chat-completions"] },
        harbor_agent: {
          import_path: "example.agent:Agent",
          kwargs: { version: "1.0.0" },
        },
      },
    };
    expect(validateControlRecord(profile)).toEqual(profile);
    expect(() =>
      validateControlRecord({
        ...profile,
        spec: {
          ...profile.spec,
          harbor_agent: {
            ...profile.spec.harbor_agent,
            model_name: "openai/example/model:provider",
          },
        },
      }),
    ).toThrow(ContractValidationError);
    expect(() =>
      validateControlRecord({
        ...profile,
        spec: {
          ...profile.spec,
          harbor_agent: {
            ...profile.spec.harbor_agent,
            kwargs: { models_json: { providers: {} } },
          },
        },
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
        source_run_ids: ["20260815T000000Z-source"],
        source_revisions: ["revision-one"],
      },
    };
    expect(validateControlRecord(profile)).toEqual(profile);
    expect(
      validateRunSubmission({
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
        kind: "run.lock",
        record_id: "lock-real-task-id",
        created_at: "2026-08-16T00:00:00Z",
        actor: { subject: "migration", role: "migration" },
        run_id: "run-real-task-id",
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
    ).toMatchObject({ kind: "run.lock" });
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
          run_id: "run-test",
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

  it("validates leaderboard snapshot receipts", () => {
    const snapshot = {
      schema_version: "v1",
      kind: "leaderboard.snapshot",
      record_id: "leaderboard-snapshot-test",
      created_at: "2026-08-16T00:00:00Z",
      actor: { subject: "harbor-hf-control", role: "service" },
      sqlite_key:
        "results/schema=v1/leaderboard/snapshots/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/leaderboard.sqlite",
      sqlite_digest: `sha256:${"a".repeat(64)}`,
      source_digest: `sha256:${"b".repeat(64)}`,
      entry_count: 1,
    };
    expect(validateLeaderboardSnapshot(snapshot)).toEqual(snapshot);
    expect(() => validateLeaderboardSnapshot({ ...snapshot, extra: 1 })).toThrow(
      ContractValidationError,
    );
  });

  it("derives stable Bucket paths", () => {
    expect(
      controlRecordPath({
        kind: "action.intent",
        record_id: "action-1",
        run_id: "run-1",
        action_id: "action-1",
      }),
    ).toBe("control/schema=v1/runs/run-1/actions/action-1/intent.json");
    expect(
      controlRecordPath({
        kind: "action.advanced",
        record_id: "advanced-1",
        run_id: "run-1",
        action_id: "action-1",
      }),
    ).toBe("control/schema=v1/runs/run-1/actions/action-1/zz-advanced.json");
  });

  it("validates run submission boundaries", () => {
    expect(
      validateRunSubmission({
        benchmark: "control-smoke",
        model: "control-smoke",
        harness: "control-smoke",
        launch_policy: "control-smoke",
        ceiling_microusd: 0,
        confirmed: true,
      }),
    ).toMatchObject({ confirmed: true });
    expect(() =>
      validateRunSubmission({
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
