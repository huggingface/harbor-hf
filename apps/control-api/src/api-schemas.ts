const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] } as const;
const integer = { type: "integer" } as const;
const nullableInteger = {
  anyOf: [{ type: "integer" }, { type: "null" }],
} as const;

export const campaignViewSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "campaign_id",
    "created_at",
    "status",
    "ceiling_microusd",
    "reserved_microusd",
    "observed_microusd",
    "total_tasks",
    "terminal_tasks",
    "successful_tasks",
    "pending_actions",
    "publication_status",
    "cleanup_pending",
    "cancellation_requested",
  ],
  properties: {
    campaign_id: { type: "string" },
    created_at: { type: "string", format: "date-time" },
    status: { type: "string" },
    ceiling_microusd: integer,
    reserved_microusd: integer,
    observed_microusd: integer,
    total_tasks: integer,
    terminal_tasks: integer,
    successful_tasks: integer,
    pending_actions: integer,
    publication_status: nullableString,
    cleanup_pending: { type: "boolean" },
    cancellation_requested: { type: "boolean" },
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
    "campaign_limit",
    "campaign_active",
    "hardware_limit",
    "hardware_active",
    "provider_limit",
    "provider_reserved",
    "start_tokens",
    "start_burst",
    "queued",
    "cleanup_held",
    "limiting_factor",
    "not_before",
  ],
  properties: {
    configured: { type: "boolean" },
    profile_id: nullableString,
    namespace_limit: nullableInteger,
    namespace_active: integer,
    campaign_limit: integer,
    campaign_active: integer,
    hardware_limit: nullableInteger,
    hardware_active: integer,
    provider_limit: integer,
    provider_reserved: integer,
    start_tokens: nullableInteger,
    start_burst: nullableInteger,
    queued: integer,
    cleanup_held: integer,
    limiting_factor: nullableString,
    not_before: nullableString,
  },
} as const;

export const campaignListSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "next_cursor"],
  properties: {
    items: { type: "array", items: campaignViewSchema },
    next_cursor: nullableString,
  },
} as const;

export const acceptedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["campaign_id", "action_id", "status_url", "adopted"],
  properties: {
    campaign_id: { type: "string" },
    action_id: { type: "string" },
    status_url: { type: "string" },
    adopted: { type: "boolean" },
  },
} as const;

export const actionDispositionCorrectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action_ids", "reason", "confirmed"],
  properties: {
    action_ids: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{1,159}$" },
    },
    reason: { type: "string", minLength: 1, maxLength: 1000 },
    confirmed: { const: true },
  },
} as const;

export const actionDispositionCorrectionResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["batch_id", "batch_digest", "items"],
  properties: {
    batch_id: { type: "string" },
    batch_digest: { type: "string" },
    items: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action_id", "disposition_record_id", "created"],
        properties: {
          action_id: { type: "string" },
          disposition_record_id: { type: "string" },
          created: { type: "boolean" },
        },
      },
    },
  },
} as const;

export const actionDispositionViewSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "action_id",
    "campaign_id",
    "task_id",
    "recorded_outcome",
    "recorded_observed_state",
    "effective_outcome",
    "effective_observed_state",
    "effective_error_code",
    "reason_code",
    "corrected_at",
    "actor_role",
    "disposition_record_id",
    "batch_id",
    "batch_size",
  ],
  properties: {
    action_id: { type: "string" },
    campaign_id: { type: "string" },
    task_id: { type: "string" },
    recorded_outcome: { type: "string" },
    recorded_observed_state: { type: "string" },
    effective_outcome: { type: "string" },
    effective_observed_state: { type: "string" },
    effective_error_code: { type: "string" },
    reason_code: { type: "string" },
    corrected_at: { type: "string", format: "date-time" },
    actor_role: { type: "string" },
    disposition_record_id: { type: "string" },
    batch_id: { type: "string" },
    batch_size: integer,
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
  required: ["campaign_id", "task_id", "attempt_id", "status_url", "adopted"],
  properties: {
    campaign_id: { type: "string" },
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
    "campaign_id",
    "task_id",
    "input_digest",
    "terminal_outcome",
    "selected_attempt_id",
  ],
  properties: {
    campaign_id: { type: "string" },
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
    "campaign_id",
    "task_id",
    "outcome",
    "replacement_eligible",
    "cost_microusd",
    "metrics",
    "created_at",
  ],
  properties: {
    attempt_id: { type: "string" },
    action_id: { type: "string" },
    campaign_id: { type: "string" },
    task_id: { type: "string" },
    outcome: { type: "string" },
    replacement_eligible: integer,
    cost_microusd: integer,
    metrics: { type: "object", additionalProperties: { type: "number" } },
    created_at: { type: "string", format: "date-time" },
  },
} as const;

export const taskDetailSchema = {
  type: "object",
  additionalProperties: false,
  required: ["task", "attempts"],
  properties: {
    task: taskSchema,
    attempts: { type: "array", items: attemptSchema },
  },
} as const;

export const actionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "action_id",
    "campaign_id",
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
    campaign_id: { type: "string" },
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
  required: [...actionSchema.required, "inspect_url", "cost_microusd"],
  properties: {
    ...actionSchema.properties,
    inspect_url: nullableString,
    cost_microusd: integer,
  },
} as const;

export const endpointSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "action_id",
    "campaign_id",
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
    campaign_id: { type: "string" },
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
  required: [
    "publication_id",
    "campaign_id",
    "status",
    "catalog_digest",
    "published_at",
  ],
  properties: {
    publication_id: { type: "string" },
    campaign_id: { type: "string" },
    status: { type: "string" },
    catalog_digest: nullableString,
    published_at: { type: "string", format: "date-time" },
    run_id: nullableString,
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
    profile_ids: {
      type: "object",
      additionalProperties: { type: "string" },
    },
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
  required: ["source_revision", "write_mode", "projection", "resource_contract"],
  properties: {
    source_revision: { type: "string" },
    write_mode: { enum: ["disabled", "canary", "enabled"] },
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
