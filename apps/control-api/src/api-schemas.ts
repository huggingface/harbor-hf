const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] } as const;
const integer = { type: "integer" } as const;
const nullableInteger = {
  anyOf: [{ type: "integer" }, { type: "null" }],
} as const;

export const runViewSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "run_id",
    "created_at",
    "status",
    "ceiling_microusd",
    "reserved_microusd",
    "observed_microusd",
    "budget_exceeded",
    "total_tasks",
    "terminal_tasks",
    "admissible_tasks",
    "invalid_selected_tasks",
    "exhausted_tasks",
    "successful_tasks",
    "pending_actions",
    "replacement_assigned_tasks",
    "replacement_recorded_tasks",
    "publication_status",
    "cleanup_pending",
    "cancellation_requested",
    "paused",
  ],
  properties: {
    run_id: { type: "string" },
    created_at: { type: "string", format: "date-time" },
    status: { type: "string" },
    ceiling_microusd: integer,
    reserved_microusd: integer,
    observed_microusd: integer,
    budget_exceeded: { type: "boolean" },
    total_tasks: integer,
    terminal_tasks: integer,
    admissible_tasks: integer,
    invalid_selected_tasks: integer,
    exhausted_tasks: integer,
    successful_tasks: integer,
    pending_actions: integer,
    replacement_assigned_tasks: integer,
    replacement_recorded_tasks: integer,
    publication_status: nullableString,
    cleanup_pending: { type: "boolean" },
    cancellation_requested: { type: "boolean" },
    paused: { type: "boolean" },
  },
} as const;

export const namespaceCapacityPolicySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "alias",
    "configured",
    "max_active_jobs",
    "start_burst",
    "start_refill_tokens",
    "start_refill_period_seconds",
    "profile_id",
  ],
  properties: {
    alias: nullableString,
    configured: { type: "boolean" },
    max_active_jobs: nullableInteger,
    start_burst: nullableInteger,
    start_refill_tokens: nullableInteger,
    start_refill_period_seconds: nullableInteger,
    profile_id: nullableString,
  },
} as const;

export const namespaceCapacityViewSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "alias",
    "configured",
    "max_active_jobs",
    "active_jobs",
    "available_jobs",
    "queued_jobs",
    "observed_running_jobs",
    "observed_scheduling_jobs",
    "reserved_without_active_observation",
    "start_tokens",
    "start_burst",
    "start_refill_tokens",
    "start_refill_period_seconds",
    "profile_id",
    "runs",
    "hardware",
  ],
  properties: {
    ...namespaceCapacityPolicySchema.properties,
    active_jobs: integer,
    available_jobs: nullableInteger,
    queued_jobs: integer,
    observed_running_jobs: integer,
    observed_scheduling_jobs: integer,
    reserved_without_active_observation: integer,
    start_tokens: nullableInteger,
    runs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["run_id", "max_active_jobs", "active_jobs", "available_jobs"],
        properties: {
          run_id: { type: "string" },
          max_active_jobs: integer,
          active_jobs: integer,
          available_jobs: integer,
        },
      },
    },
    hardware: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["hardware", "max_active_jobs", "active_jobs", "available_jobs"],
        properties: {
          hardware: { type: "string" },
          max_active_jobs: integer,
          active_jobs: integer,
          available_jobs: integer,
        },
      },
    },
  },
} as const;

export const namespaceCapacityUpdateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["max_active_jobs", "confirmed"],
  properties: {
    max_active_jobs: { type: "integer", minimum: 1, maximum: 1024 },
    confirmed: { const: true },
  },
} as const;

export const capacitySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "configured",
    "profile_id",
    "namespace_limit",
    "namespace_active",
    "run_limit",
    "run_active",
    "hardware_limit",
    "hardware_active",
    "provider_limit",
    "provider_reserved",
    "start_tokens",
    "start_burst",
    "queued",
    "limiting_factor",
    "not_before",
  ],
  properties: {
    configured: { type: "boolean" },
    profile_id: nullableString,
    namespace_limit: nullableInteger,
    namespace_active: integer,
    run_limit: integer,
    run_active: integer,
    hardware_limit: nullableInteger,
    hardware_active: integer,
    provider_limit: integer,
    provider_reserved: integer,
    start_tokens: nullableInteger,
    start_burst: nullableInteger,
    queued: integer,
    limiting_factor: nullableString,
    not_before: nullableString,
  },
} as const;

export const runListSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "next_cursor"],
  properties: {
    items: { type: "array", items: runViewSchema },
    next_cursor: nullableString,
  },
} as const;

export const acceptedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["run_id", "action_id", "status_url", "adopted"],
  properties: {
    run_id: { type: "string" },
    action_id: { type: "string" },
    status_url: { type: "string" },
    adopted: { type: "boolean" },
  },
} as const;

export const runContinuationAcceptedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["run_id", "continuation_id", "status_url", "adopted"],
  properties: {
    run_id: { type: "string" },
    continuation_id: { type: "string" },
    status_url: { type: "string" },
    adopted: { type: "boolean" },
  },
} as const;

export const runContinuationRepairAcceptedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["run_id", "continuation_repair_id", "status_url", "adopted"],
  properties: {
    run_id: { type: "string" },
    continuation_repair_id: { type: "string" },
    status_url: { type: "string" },
    adopted: { type: "boolean" },
  },
} as const;

export const runContinuationRepairSuccessorAcceptedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["run_id", "continuation_repair_successor_id", "status_url", "adopted"],
  properties: {
    run_id: { type: "string" },
    continuation_repair_successor_id: { type: "string" },
    status_url: { type: "string" },
    adopted: { type: "boolean" },
  },
} as const;

export const evidenceUploadSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation", "action_id", "digest", "content_base64"],
  properties: {
    operation: { const: "upload_evidence" },
    action_id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{1,159}$" },
    digest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    content_base64: {
      type: "string",
      minLength: 1,
      maxLength: 12000000,
      pattern: "^[A-Za-z0-9+/]*={0,2}$",
    },
  },
} as const;

export const evidenceAcceptedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "digest", "size", "created"],
  properties: {
    path: { type: "string" },
    digest: { type: "string" },
    size: integer,
    created: { type: "boolean" },
  },
} as const;

export const attemptAcceptedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["run_id", "task_id", "attempt_id", "status_url", "adopted"],
  properties: {
    run_id: { type: "string" },
    task_id: { type: "string" },
    attempt_id: { type: "string" },
    status_url: { type: "string" },
    adopted: { type: "boolean" },
  },
} as const;

export const taskSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "run_id",
    "task_id",
    "input_digest",
    "terminal_outcome",
    "selected_attempt_id",
  ],
  properties: {
    run_id: { type: "string" },
    task_id: { type: "string" },
    input_digest: { type: "string" },
    terminal_outcome: nullableString,
    selected_attempt_id: nullableString,
  },
} as const;

export const attemptSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "attempt_id",
    "action_id",
    "run_id",
    "task_id",
    "outcome",
    "replacement_eligible",
    "failure_fingerprint",
    "cost_microusd",
    "metrics",
    "created_at",
    "physical_job",
  ],
  properties: {
    attempt_id: { type: "string" },
    action_id: { type: "string" },
    run_id: { type: "string" },
    task_id: { type: "string" },
    outcome: { type: "string" },
    replacement_eligible: integer,
    failure_fingerprint: nullableString,
    cost_microusd: integer,
    metrics: { type: "object", additionalProperties: { type: "number" } },
    created_at: { type: "string", format: "date-time" },
    physical_job: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["resource_id", "observed_state", "inspect_url"],
          properties: {
            resource_id: nullableString,
            observed_state: nullableString,
            inspect_url: nullableString,
          },
        },
      ],
    },
  },
} as const;

export const taskDetailSchema = {
  type: "object",
  additionalProperties: false,
  required: ["task", "attempts", "exhaustion"],
  properties: {
    task: taskSchema,
    attempts: { type: "array", items: attemptSchema },
    exhaustion: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: [
            "source_action_id",
            "last_attempt_id",
            "attempt_count",
            "reason",
            "created_at",
          ],
          properties: {
            source_action_id: { type: "string" },
            last_attempt_id: nullableString,
            attempt_count: integer,
            reason: { type: "string" },
            created_at: { type: "string", format: "date-time" },
          },
        },
      ],
    },
  },
} as const;

export const actionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "action_id",
    "run_id",
    "action_kind",
    "generation",
    "target",
    "outcome",
    "observed_state",
    "resource_id",
    "created_at",
  ],
  properties: {
    action_id: { type: "string" },
    run_id: { type: "string" },
    action_kind: { type: "string" },
    generation: integer,
    target: { type: "string" },
    outcome: nullableString,
    observed_state: nullableString,
    resource_id: nullableString,
    created_at: { type: "string", format: "date-time" },
  },
} as const;

export const jobSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    ...actionSchema.required,
    "launch_action_id",
    "inspect_url",
    "cost_microusd",
    "assigned_tasks",
  ],
  properties: {
    ...actionSchema.properties,
    launch_action_id: { type: "string" },
    inspect_url: nullableString,
    cost_microusd: integer,
    assigned_tasks: integer,
  },
} as const;

export const endpointSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "action_id",
    "run_id",
    "endpoint_id",
    "desired_state",
    "observed_state",
    "ready_replicas",
    "cleanup_verified",
    "active_hourly_cost_microusd",
    "created_at",
  ],
  properties: {
    action_id: { type: "string" },
    run_id: { type: "string" },
    endpoint_id: { type: "string" },
    desired_state: { type: "string" },
    observed_state: { type: "string" },
    ready_replicas: integer,
    cleanup_verified: integer,
    active_hourly_cost_microusd: integer,
    created_at: { type: "string", format: "date-time" },
  },
} as const;

export const profileSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "profile_id",
    "profile_kind",
    "name",
    "source",
    "promotion_state",
    "alias",
    "approved_aliases",
    "spec",
    "created_at",
  ],
  properties: {
    profile_id: { type: "string" },
    profile_kind: { type: "string" },
    name: { type: "string" },
    source: { type: "string" },
    promotion_state: nullableString,
    alias: nullableString,
    approved_aliases: {
      type: "array",
      items: { type: "string" },
      maxItems: 100,
    },
    spec: { type: "object", additionalProperties: true },
    created_at: { type: "string", format: "date-time" },
  },
} as const;

export const publicationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["publication_id", "run_id", "status", "catalog_digest", "published_at"],
  properties: {
    publication_id: { type: "string" },
    run_id: { type: "string" },
    status: { type: "string" },
    catalog_digest: nullableString,
    published_at: { type: "string", format: "date-time" },
    benchmark: nullableString,
    model: nullableString,
    harness: nullableString,
    inference_provider: nullableString,
    run_outcome: nullableString,
    quality: nullableString,
    publication_role: nullableString,
    task_count: nullableInteger,
    scored_task_count: nullableInteger,
    strict_pass_count: nullableInteger,
    primary_metric: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["name", "value", "unit"],
          properties: {
            name: { type: "string" },
            value: { type: "number" },
            unit: { type: "string" },
          },
        },
        { type: "null" },
      ],
    },
    result_path: nullableString,
    pass_count: nullableInteger,
    pass_rate: { anyOf: [{ type: "number" }, { type: "null" }] },
    pass_rate_ci95: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["low", "high"],
          properties: {
            low: { type: "number" },
            high: { type: "number" },
          },
        },
        { type: "null" },
      ],
    },
    input_tokens: nullableInteger,
    output_tokens: nullableInteger,
    inference_cost_microusd: nullableInteger,
    mean_task_cost_microusd: { anyOf: [{ type: "number" }, { type: "null" }] },
    task_cost_ci95: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["low", "high"],
          properties: {
            low: { type: "number" },
            high: { type: "number" },
          },
        },
        { type: "null" },
      ],
    },
    observed_cost_microusd: nullableInteger,
    outputs_prefix: nullableString,
    outputs_url: nullableString,
    hf_uri: nullableString,
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "task_id",
          "outcome",
          "reward",
          "cost_microusd",
          "input_tokens",
          "output_tokens",
        ],
        properties: {
          task_id: { type: "string" },
          outcome: { type: "string" },
          reward: { anyOf: [{ type: "number" }, { type: "null" }] },
          cost_microusd: { type: "integer" },
          input_tokens: nullableInteger,
          output_tokens: nullableInteger,
        },
      },
    },
    benchmark_revision: nullableString,
    model_revision: nullableString,
    harness_revision: nullableString,
    agent: nullableString,
    source_revision: nullableString,
    catalog_source_digest: nullableString,
    superseded_by_publication_id: nullableString,
    profile_ids: {
      type: "object",
      additionalProperties: { type: "string" },
    },
  },
} as const;

export const leaderboardRowSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "rank",
    "pareto",
    "configuration_digest",
    "run_id",
    "publication_id",
    "published_at",
    "benchmark",
    "model",
    "harness",
    "inference_provider",
    "reasoning_effort",
    "harbor_version",
    "trial_count",
    "task_count",
    "scored_task_count",
    "primary_metric_name",
    "primary_metric_value",
    "primary_metric_unit",
    "observed_microusd",
  ],
  properties: {
    rank: integer,
    pareto: { type: "boolean" },
    configuration_digest: { type: "string" },
    run_id: { type: "string" },
    publication_id: { type: "string" },
    published_at: { type: "string", format: "date-time" },
    benchmark: { type: "string" },
    model: { type: "string" },
    harness: { type: "string" },
    inference_provider: { type: "string" },
    reasoning_effort: { type: "string" },
    harbor_version: { type: "string" },
    trial_count: integer,
    task_count: integer,
    scored_task_count: integer,
    primary_metric_name: { type: "string" },
    primary_metric_value: { type: "number" },
    primary_metric_unit: { type: "string" },
    observed_microusd: integer,
  },
} as const;

export const leaderboardSchema = {
  type: "object",
  additionalProperties: false,
  required: ["snapshot", "items"],
  properties: {
    snapshot: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "record_id",
            "created_at",
            "sqlite_digest",
            "source_digest",
            "entry_count",
          ],
          properties: {
            record_id: { type: "string" },
            created_at: { type: "string", format: "date-time" },
            sqlite_digest: { type: "string" },
            source_digest: { type: "string" },
            entry_count: integer,
          },
        },
        { type: "null" },
      ],
    },
    items: { type: "array", items: leaderboardRowSchema },
  },
} as const;

export const itemList = (item: object) =>
  ({
    type: "object",
    additionalProperties: false,
    required: ["items", "next_cursor"],
    properties: {
      items: { type: "array", items: item },
      next_cursor: nullableString,
    },
  }) as const;

export const sessionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["authenticated"],
  properties: {
    authenticated: { type: "boolean" },
    login_url: { type: "string" },
    expires_at: { type: "string", format: "date-time" },
    actor: {
      type: "object",
      additionalProperties: false,
      required: ["username", "role", "transport"],
      properties: {
        username: { type: "string" },
        role: { enum: ["operator", "reader"] },
        transport: { enum: ["session", "development"] },
      },
    },
  },
} as const;

export const systemSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "source_revision",
    "write_mode",
    "initialization",
    "projection",
    "resource_contract",
  ],
  properties: {
    source_revision: { type: "string" },
    write_mode: { enum: ["disabled", "enabled"] },
    initialization: {
      type: "object",
      additionalProperties: false,
      required: ["ready", "status"],
      properties: {
        ready: { type: "boolean" },
        status: { enum: ["initializing", "ready"] },
      },
    },
    projection: {
      type: "object",
      additionalProperties: false,
      required: [
        "ready",
        "rebuilding",
        "object_count",
        "last_rebuild_at",
        "last_sync_at",
        "event_cursor",
        "integrity_error",
      ],
      properties: {
        ready: { type: "boolean" },
        rebuilding: { type: "boolean" },
        object_count: integer,
        last_rebuild_at: nullableString,
        last_sync_at: nullableString,
        event_cursor: nullableString,
        integrity_error: nullableString,
      },
    },
    resource_contract: { type: "object", additionalProperties: { type: "integer" } },
  },
} as const;

export const auditSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "next_cursor"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "occurred_at", "data"],
        properties: {
          id: { type: "string" },
          type: { type: "string" },
          occurred_at: { type: "string", format: "date-time" },
          data: { type: "object", additionalProperties: true },
        },
      },
    },
    next_cursor: nullableString,
  },
} as const;
