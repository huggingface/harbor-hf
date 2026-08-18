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
    "pending_actions",
    "publication_status",
    "cleanup_pending",
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
    pending_actions: integer,
    publication_status: nullableString,
    cleanup_pending: { type: "boolean" },
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
