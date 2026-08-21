import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ActionAdvanced,
  ActionDispatch,
  ActionDisposition,
  ActionIntent,
  ActionReceipt,
  AttemptReceipt,
  BudgetEvent,
  CampaignLock,
  CampaignRequest,
  EndpointResource,
  HarborHFControlRecordV1,
  OperatorAcl,
  ProfileObject,
  ProfilePromotion,
  PublicationReceipt,
  SandboxAdmissionGrant,
  SandboxCapacityRelease,
  TerminalSelection,
} from "@harbor-hf/contracts";
import {
  ContractValidationError,
  canonicalJson,
  deterministicId,
  sandboxActionResultPath,
  sha256,
  validateControlRecord,
} from "@harbor-hf/contracts";
import Database from "better-sqlite3";
import { Kysely, type Selectable, SqliteDialect, sql } from "kysely";
import { historicalDispositionResourceMatches } from "./disposition-policy.js";
import { type ControlEvent, decodeEventCursor, eventCursor } from "./events.js";
import { verifyEvidenceReference, verifyWorkerEvidence } from "./evidence.js";
import type { PromotedProfile } from "./profiles.js";
import type { ImmutableObjectStore, ObjectEntry } from "./store.js";

interface ObjectRow {
  key: string;
  digest: string;
  kind: string;
  record_id: string;
  created_at: string;
  body: string;
}

interface CampaignRow {
  campaign_id: string;
  created_at: string;
  request_body: string | null;
  lock_body: string | null;
  ceiling_microusd: number;
}

interface ActionRow {
  action_id: string;
  campaign_id: string;
  action_kind: string;
  generation: number;
  target: string;
  intent_body: string;
  receipt_body: string | null;
  outcome: string | null;
  observed_state: string | null;
  resource_id: string | null;
  created_at: string;
}

interface DispositionRow {
  action_id: string;
  campaign_id: string;
  task_id: string;
  record_id: string;
  source_receipt_id: string;
  source_receipt_digest: string;
  close_action_id: string;
  close_receipt_id: string;
  close_receipt_digest: string;
  batch_id: string;
  batch_digest: string;
  batch_size: number;
  effective_outcome: string;
  effective_observed_state: string;
  effective_error_code: string;
  reason_code: string;
  reason: string;
  created_at: string;
  body: string;
}

interface DispatchRow {
  action_id: string;
  campaign_id: string;
  operation: string;
  adoption_not_before: string;
  created_at: string;
  body: string;
}

interface AdmissionRow {
  action_id: string;
  campaign_id: string;
  namespace: string;
  capacity_profile_id: string;
  hardware: string;
  reserved_provider_requests: number;
  tokens_remaining: number;
  refill_cursor_at: string;
  previous_grant_id: string | null;
  created_at: string;
  body: string;
}

interface CapacityReleaseRow {
  action_id: string;
  campaign_id: string;
  grant_id: string;
  release_reason: string;
  evidence_record_id: string;
  created_at: string;
  body: string;
}

interface AdvancementRow {
  action_id: string;
  campaign_id: string;
  created_at: string;
  body: string;
}

interface TaskRow {
  campaign_id: string;
  task_id: string;
  input_digest: string;
  terminal_outcome: string | null;
  selected_attempt_id: string | null;
}

interface AttemptRow {
  attempt_id: string;
  action_id: string;
  campaign_id: string;
  task_id: string;
  outcome: string;
  replacement_eligible: number;
  evidence_digest: string;
  evidence_path: string;
  cost_microusd: number;
  metrics_body: string;
  created_at: string;
  body: string;
}

interface BudgetRow {
  record_id: string;
  campaign_id: string;
  event_kind: string;
  amount_microusd: number;
  created_at: string;
}

interface EndpointRow {
  action_id: string;
  campaign_id: string;
  endpoint_id: string;
  desired_state: string;
  observed_state: string;
  ready_replicas: number;
  cleanup_verified: number;
  active_hourly_cost_microusd: number;
  created_at: string;
}

interface PublicationRow {
  publication_id: string;
  campaign_id: string;
  status: string;
  catalog_digest: string | null;
  body: string;
  created_at: string;
}

interface ProfileRow {
  profile_id: string;
  profile_kind: string;
  name: string;
  spec_body: string;
  source: string;
  created_at: string;
}

interface PromotionRow {
  record_id: string;
  profile_kind: string;
  alias: string;
  profile_id: string;
  state: string;
  created_at: string;
  body: string;
}

interface AclRow {
  record_id: string;
  created_at: string;
  body: string;
}

interface MigrationRow {
  record_id: string;
  created_at: string;
  body: string;
}

interface DatabaseSchema {
  objects: ObjectRow;
  campaigns: CampaignRow;
  actions: ActionRow;
  dispositions: DispositionRow;
  dispatches: DispatchRow;
  sandbox_admissions: AdmissionRow;
  sandbox_capacity_releases: CapacityReleaseRow;
  advancements: AdvancementRow;
  tasks: TaskRow;
  attempts: AttemptRow;
  budgets: BudgetRow;
  endpoints: EndpointRow;
  publications: PublicationRow;
  profiles: ProfileRow;
  promotions: PromotionRow;
  acls: AclRow;
  migrations: MigrationRow;
}

export interface CampaignView {
  campaign_id: string;
  created_at: string;
  status: string;
  ceiling_microusd: number;
  reserved_microusd: number;
  observed_microusd: number;
  total_tasks: number;
  terminal_tasks: number;
  successful_tasks: number;
  pending_actions: number;
  publication_status: string | null;
  cleanup_pending: boolean;
  cancellation_requested: boolean;
}

export interface ActionDispositionView {
  action_id: string;
  campaign_id: string;
  task_id: string;
  recorded_outcome: string;
  recorded_observed_state: string;
  effective_outcome: string;
  effective_observed_state: string;
  effective_error_code: string;
  reason_code: string;
  corrected_at: string;
  actor_role: string;
  disposition_record_id: string;
  batch_id: string;
  batch_size: number;
}

export interface SystemView {
  ready: boolean;
  rebuilding: boolean;
  object_count: number;
  last_rebuild_at: string | null;
  last_sync_at: string | null;
  event_cursor: string | null;
  integrity_error: string | null;
}

export class ProjectionIntegrityError extends Error {}

const terminalSandboxStates = new Set([
  "CANCELED",
  "CANCELLED",
  "COMPLETED",
  "DELETED",
  "ERROR",
  "STOPPED",
]);

function body(value: unknown): string {
  return canonicalJson(value).trimEnd();
}

async function verifyAttemptEvidence(
  store: ImmutableObjectStore,
  record: HarborHFControlRecordV1,
): Promise<void> {
  if (record.kind !== "attempt.receipt" || record.actor.role === "migration") return;
  if (record.actor.subject === "harbor-hf-control")
    await verifyEvidenceReference(store, record.evidence_path, record.evidence_digest);
  else await verifyWorkerEvidence(store, record);
}

function parseRecord(bytes: Uint8Array, entry: ObjectEntry): HarborHFControlRecordV1 {
  const text = new TextDecoder().decode(bytes);
  if (sha256(bytes) !== entry.digest) {
    throw new ProjectionIntegrityError(`digest mismatch for ${entry.key}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProjectionIntegrityError(`invalid JSON at ${entry.key}`);
  }
  if (canonicalJson(value) !== text) {
    throw new ProjectionIntegrityError(`non-canonical JSON at ${entry.key}`);
  }
  try {
    return validateControlRecord<HarborHFControlRecordV1>(value);
  } catch (error) {
    const details =
      error instanceof ContractValidationError
        ? error.errors
            .slice(0, 8)
            .map(
              (item) =>
                `${item.instancePath || "/"} ${item.message ?? "invalid"} ${JSON.stringify(item.params)}`,
            )
            .join("; ")
        : error instanceof Error
          ? error.message
          : "validation failed";
    throw new ProjectionIntegrityError(
      `invalid control record at ${entry.key}: ${details}`,
    );
  }
}

function jobIdentity(row: Selectable<ActionRow>): string {
  if (row.resource_id) return row.resource_id;
  const intent = JSON.parse(row.intent_body) as ActionIntent;
  const payloadResourceId = intent.payload.resource_id;
  if (typeof payloadResourceId === "string") return payloadResourceId;
  const launchActionId = intent.payload.launch_action_id;
  if (typeof launchActionId === "string") return launchActionId;
  const sandboxCreateId = intent.payload.sandbox_create_action_id;
  if (typeof sandboxCreateId === "string") return sandboxCreateId;
  return row.action_id;
}

function receiptCostMicrousd(row: Selectable<ActionRow>): number {
  if (!row.receipt_body) return 0;
  const receipt = JSON.parse(row.receipt_body) as ActionReceipt;
  return receipt.cost_microusd ?? 0;
}

const hardwareActionKinds = [
  "job.launch",
  "job.observe",
  "job.cancel",
  "sandbox.create",
  "sandbox.observe",
  "sandbox.close",
] as const;

export class Projection {
  private database: Database.Database;
  readonly db: Kysely<DatabaseSchema>;
  private state: SystemView = {
    ready: false,
    rebuilding: true,
    object_count: 0,
    last_rebuild_at: null,
    last_sync_at: null,
    event_cursor: null,
    integrity_error: null,
  };

  private constructor(
    readonly path: string,
    database: Database.Database,
  ) {
    this.database = database;
    this.db = new Kysely<DatabaseSchema>({ dialect: new SqliteDialect({ database }) });
  }

  static async open(path: string): Promise<Projection> {
    await mkdir(dirname(path), { recursive: true });
    const database = new Database(path);
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("synchronous = FULL");
    const projection = new Projection(path, database);
    await projection.initialize();
    return projection;
  }

  system(): SystemView {
    return { ...this.state };
  }

  private async latestEventCursor(): Promise<string | null> {
    const row = await this.db
      .selectFrom("objects")
      .select(["key", "created_at"])
      .orderBy("created_at", "desc")
      .orderBy("key", "desc")
      .executeTakeFirst();
    return row ? eventCursor(row.created_at, row.key) : null;
  }

  async objectDigest(key: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("objects")
      .select("digest")
      .where("key", "=", key)
      .executeTakeFirst();
    return row?.digest ?? null;
  }

  private async initialize(): Promise<void> {
    await this.db.schema
      .createTable("objects")
      .ifNotExists()
      .addColumn("key", "text", (column) => column.primaryKey())
      .addColumn("digest", "text", (column) => column.notNull())
      .addColumn("kind", "text", (column) => column.notNull())
      .addColumn("record_id", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("body", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("campaigns")
      .ifNotExists()
      .addColumn("campaign_id", "text", (column) => column.primaryKey())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("request_body", "text")
      .addColumn("lock_body", "text")
      .addColumn("ceiling_microusd", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .execute();
    await this.db.schema
      .createTable("actions")
      .ifNotExists()
      .addColumn("action_id", "text", (column) => column.primaryKey())
      .addColumn("campaign_id", "text", (column) => column.notNull())
      .addColumn("action_kind", "text", (column) => column.notNull())
      .addColumn("generation", "integer", (column) => column.notNull())
      .addColumn("target", "text", (column) => column.notNull())
      .addColumn("intent_body", "text", (column) => column.notNull())
      .addColumn("receipt_body", "text")
      .addColumn("outcome", "text")
      .addColumn("observed_state", "text")
      .addColumn("resource_id", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("dispositions")
      .ifNotExists()
      .addColumn("action_id", "text", (column) => column.primaryKey())
      .addColumn("campaign_id", "text", (column) => column.notNull())
      .addColumn("task_id", "text", (column) => column.notNull())
      .addColumn("record_id", "text", (column) => column.notNull().unique())
      .addColumn("source_receipt_id", "text", (column) => column.notNull())
      .addColumn("source_receipt_digest", "text", (column) => column.notNull())
      .addColumn("close_action_id", "text", (column) => column.notNull())
      .addColumn("close_receipt_id", "text", (column) => column.notNull())
      .addColumn("close_receipt_digest", "text", (column) => column.notNull())
      .addColumn("batch_id", "text", (column) => column.notNull())
      .addColumn("batch_digest", "text", (column) => column.notNull())
      .addColumn("batch_size", "integer", (column) => column.notNull())
      .addColumn("effective_outcome", "text", (column) => column.notNull())
      .addColumn("effective_observed_state", "text", (column) => column.notNull())
      .addColumn("effective_error_code", "text", (column) => column.notNull())
      .addColumn("reason_code", "text", (column) => column.notNull())
      .addColumn("reason", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("body", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("dispatches")
      .ifNotExists()
      .addColumn("action_id", "text", (column) => column.primaryKey())
      .addColumn("campaign_id", "text", (column) => column.notNull())
      .addColumn("operation", "text", (column) => column.notNull())
      .addColumn("adoption_not_before", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("body", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("sandbox_admissions")
      .ifNotExists()
      .addColumn("action_id", "text", (column) => column.primaryKey())
      .addColumn("campaign_id", "text", (column) => column.notNull())
      .addColumn("namespace", "text", (column) => column.notNull())
      .addColumn("capacity_profile_id", "text", (column) => column.notNull())
      .addColumn("hardware", "text", (column) => column.notNull())
      .addColumn("reserved_provider_requests", "integer", (column) => column.notNull())
      .addColumn("tokens_remaining", "integer", (column) => column.notNull())
      .addColumn("refill_cursor_at", "text", (column) => column.notNull())
      .addColumn("previous_grant_id", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("body", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("sandbox_capacity_releases")
      .ifNotExists()
      .addColumn("action_id", "text", (column) => column.primaryKey())
      .addColumn("campaign_id", "text", (column) => column.notNull())
      .addColumn("grant_id", "text", (column) => column.notNull())
      .addColumn("release_reason", "text", (column) => column.notNull())
      .addColumn("evidence_record_id", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("body", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("advancements")
      .ifNotExists()
      .addColumn("action_id", "text", (column) => column.primaryKey())
      .addColumn("campaign_id", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("body", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("tasks")
      .ifNotExists()
      .addColumn("campaign_id", "text", (column) => column.notNull())
      .addColumn("task_id", "text", (column) => column.notNull())
      .addColumn("input_digest", "text", (column) => column.notNull())
      .addColumn("terminal_outcome", "text")
      .addColumn("selected_attempt_id", "text")
      .addPrimaryKeyConstraint("tasks_pk", ["campaign_id", "task_id"])
      .execute();
    await this.db.schema
      .createTable("attempts")
      .ifNotExists()
      .addColumn("attempt_id", "text", (column) => column.primaryKey())
      .addColumn("action_id", "text", (column) => column.notNull())
      .addColumn("campaign_id", "text", (column) => column.notNull())
      .addColumn("task_id", "text", (column) => column.notNull())
      .addColumn("outcome", "text", (column) => column.notNull())
      .addColumn("replacement_eligible", "integer", (column) => column.notNull())
      .addColumn("evidence_digest", "text", (column) => column.notNull())
      .addColumn("evidence_path", "text", (column) => column.notNull())
      .addColumn("cost_microusd", "integer", (column) => column.notNull())
      .addColumn("metrics_body", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("body", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("budgets")
      .ifNotExists()
      .addColumn("record_id", "text", (column) => column.primaryKey())
      .addColumn("campaign_id", "text", (column) => column.notNull())
      .addColumn("event_kind", "text", (column) => column.notNull())
      .addColumn("amount_microusd", "integer", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("endpoints")
      .ifNotExists()
      .addColumn("action_id", "text", (column) => column.primaryKey())
      .addColumn("campaign_id", "text", (column) => column.notNull())
      .addColumn("endpoint_id", "text", (column) => column.notNull())
      .addColumn("desired_state", "text", (column) => column.notNull())
      .addColumn("observed_state", "text", (column) => column.notNull())
      .addColumn("ready_replicas", "integer", (column) => column.notNull())
      .addColumn("cleanup_verified", "integer", (column) => column.notNull())
      .addColumn("active_hourly_cost_microusd", "integer", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("publications")
      .ifNotExists()
      .addColumn("publication_id", "text", (column) => column.primaryKey())
      .addColumn("campaign_id", "text", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("catalog_digest", "text")
      .addColumn("body", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("profiles")
      .ifNotExists()
      .addColumn("profile_id", "text", (column) => column.primaryKey())
      .addColumn("profile_kind", "text", (column) => column.notNull())
      .addColumn("name", "text", (column) => column.notNull())
      .addColumn("spec_body", "text", (column) => column.notNull())
      .addColumn("source", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("promotions")
      .ifNotExists()
      .addColumn("record_id", "text", (column) => column.primaryKey())
      .addColumn("profile_kind", "text", (column) => column.notNull())
      .addColumn("alias", "text", (column) => column.notNull())
      .addColumn("profile_id", "text", (column) => column.notNull())
      .addColumn("state", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("body", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("acls")
      .ifNotExists()
      .addColumn("record_id", "text", (column) => column.primaryKey())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("body", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("migrations")
      .ifNotExists()
      .addColumn("record_id", "text", (column) => column.primaryKey())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("body", "text", (column) => column.notNull())
      .execute();
    await sql`CREATE INDEX IF NOT EXISTS actions_campaign_idx ON actions(campaign_id, created_at)`.execute(
      this.db,
    );
    await sql`CREATE INDEX IF NOT EXISTS sandbox_admissions_campaign_idx ON sandbox_admissions(campaign_id, created_at)`.execute(
      this.db,
    );
    await sql`CREATE INDEX IF NOT EXISTS sandbox_admissions_namespace_idx ON sandbox_admissions(namespace, created_at)`.execute(
      this.db,
    );
    await sql`CREATE INDEX IF NOT EXISTS dispositions_campaign_task_idx ON dispositions(campaign_id, task_id, created_at)`.execute(
      this.db,
    );
    await sql`CREATE INDEX IF NOT EXISTS dispositions_batch_idx ON dispositions(batch_id)`.execute(
      this.db,
    );
    await sql`CREATE INDEX IF NOT EXISTS attempts_task_idx ON attempts(campaign_id, task_id, created_at)`.execute(
      this.db,
    );
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS attempts_action_task_idx ON attempts(action_id, task_id)`.execute(
      this.db,
    );
  }

  private async clear(): Promise<void> {
    for (const table of [
      "migrations",
      "acls",
      "promotions",
      "profiles",
      "publications",
      "endpoints",
      "budgets",
      "attempts",
      "tasks",
      "advancements",
      "sandbox_capacity_releases",
      "sandbox_admissions",
      "dispatches",
      "dispositions",
      "actions",
      "campaigns",
      "objects",
    ] as const) {
      await this.db.deleteFrom(table).execute();
    }
  }

  async rebuild(
    store: ImmutableObjectStore,
    prefix = "control/schema=v1",
  ): Promise<void> {
    this.state = {
      ...this.state,
      ready: false,
      rebuilding: true,
      integrity_error: null,
    };
    try {
      const entries = [...(await store.list(prefix))].sort((left, right) =>
        left.key.localeCompare(right.key),
      );
      await this.clear();
      for (const entry of entries) {
        const bytes = await store.read(entry.key);
        const record = parseRecord(bytes, entry);
        await verifyAttemptEvidence(store, record);
        await this.apply(entry, record);
      }
      await this.verifyInvariants(store);
      this.state = {
        ready: true,
        rebuilding: false,
        object_count: entries.length,
        last_rebuild_at: new Date().toISOString(),
        last_sync_at: new Date().toISOString(),
        event_cursor: await this.latestEventCursor(),
        integrity_error: null,
      };
    } catch (error) {
      await this.clear();
      this.state = {
        ...this.state,
        ready: false,
        rebuilding: false,
        integrity_error:
          error instanceof Error ? error.message : "projection rebuild failed",
      };
      throw error;
    }
  }

  async sync(
    store: ImmutableObjectStore,
    prefix = "control/schema=v1",
  ): Promise<number> {
    try {
      const entries = [...(await store.list(prefix))].sort((left, right) =>
        left.key.localeCompare(right.key),
      );
      const seen = new Set<string>();
      let ingested = 0;
      for (const entry of entries) {
        if (seen.has(entry.key))
          throw new ProjectionIntegrityError(`duplicate object listing: ${entry.key}`);
        seen.add(entry.key);
        const projected = await this.objectDigest(entry.key);
        if (projected) {
          if (projected !== entry.digest)
            throw new ProjectionIntegrityError(
              `immutable object changed: ${entry.key}`,
            );
          continue;
        }
        const bytes = await store.read(entry.key);
        const record = parseRecord(bytes, entry);
        await verifyAttemptEvidence(store, record);
        await this.apply(entry, record);
        ingested += 1;
      }
      await this.verifyInvariants(store);
      this.state = {
        ...this.state,
        ready: true,
        rebuilding: false,
        object_count: this.state.object_count + ingested,
        last_sync_at: new Date().toISOString(),
        event_cursor: await this.latestEventCursor(),
        integrity_error: null,
      };
      return ingested;
    } catch (error) {
      this.state = {
        ...this.state,
        ready: false,
        rebuilding: false,
        integrity_error:
          error instanceof Error ? error.message : "projection sync failed",
      };
      throw error;
    }
  }

  async ingest(
    key: string,
    digest: string,
    record: HarborHFControlRecordV1,
    store: ImmutableObjectStore,
  ): Promise<void> {
    const entry = { key, digest, size: canonicalJson(record).length };
    await this.apply(entry, record);
    await this.verifyInvariants(store);
    this.state = {
      ...this.state,
      object_count: this.state.object_count + 1,
      last_sync_at: new Date().toISOString(),
      event_cursor: await this.latestEventCursor(),
    };
  }

  private async apply(
    entry: ObjectEntry,
    record: HarborHFControlRecordV1,
  ): Promise<void> {
    await this.db
      .insertInto("objects")
      .values({
        key: entry.key,
        digest: entry.digest,
        kind: record.kind,
        record_id: record.record_id,
        created_at: record.created_at,
        body: body(record),
      })
      .execute();
    switch (record.kind) {
      case "campaign.request":
        await this.applyCampaignRequest(record);
        break;
      case "campaign.lock":
        await this.applyCampaignLock(record);
        break;
      case "action.intent":
        await this.applyActionIntent(record);
        break;
      case "action.dispatch":
        await this.applyActionDispatch(record);
        break;
      case "sandbox.admission":
        await this.applySandboxAdmission(record);
        break;
      case "sandbox.capacity-release":
        await this.applySandboxCapacityRelease(record);
        break;
      case "action.receipt":
        await this.applyActionReceipt(record);
        break;
      case "action.disposition":
        await this.applyActionDisposition(record);
        break;
      case "action.advanced":
        await this.applyActionAdvanced(record);
        break;
      case "attempt.receipt":
        await this.applyAttempt(record);
        break;
      case "terminal.selection":
        await this.applyTerminal(record);
        break;
      case "budget.event":
        await this.applyBudget(record);
        break;
      case "endpoint.resource":
        await this.applyEndpoint(record);
        break;
      case "publication.receipt":
        await this.applyPublication(record);
        break;
      case "profile.object":
        await this.applyProfile(record, entry.digest);
        break;
      case "profile.promotion":
        await this.applyPromotion(record);
        break;
      case "operator.acl":
        await this.applyAcl(record);
        break;
      case "migration.record":
        await this.db
          .insertInto("migrations")
          .values({
            record_id: record.record_id,
            created_at: record.created_at,
            body: body(record),
          })
          .execute();
        break;
    }
  }

  private async applyCampaignRequest(record: CampaignRequest): Promise<void> {
    await this.db
      .insertInto("campaigns")
      .values({
        campaign_id: record.campaign_id,
        created_at: record.created_at,
        request_body: body(record),
        lock_body: null,
        ceiling_microusd: record.ceiling_microusd,
      })
      .onConflict((conflict) =>
        conflict.column("campaign_id").doUpdateSet({ request_body: body(record) }),
      )
      .execute();
  }

  private async applyCampaignLock(record: CampaignLock): Promise<void> {
    await this.db
      .insertInto("campaigns")
      .values({
        campaign_id: record.campaign_id,
        created_at: record.created_at,
        request_body: null,
        lock_body: body(record),
        ceiling_microusd: record.ceiling_microusd,
      })
      .onConflict((conflict) =>
        conflict.column("campaign_id").doUpdateSet({
          lock_body: body(record),
          ceiling_microusd: record.ceiling_microusd,
        }),
      )
      .execute();
    for (const task of record.tasks) {
      await this.db
        .insertInto("tasks")
        .values({
          campaign_id: record.campaign_id,
          task_id: task.task_id,
          input_digest: task.input_digest,
          terminal_outcome: null,
          selected_attempt_id: null,
        })
        .execute();
    }
  }

  private async applyActionIntent(record: ActionIntent): Promise<void> {
    await this.db
      .insertInto("actions")
      .values({
        action_id: record.action_id,
        campaign_id: record.campaign_id,
        action_kind: record.action_kind,
        generation: record.generation,
        target: record.target,
        intent_body: body(record),
        receipt_body: null,
        outcome: null,
        observed_state: null,
        resource_id: null,
        created_at: record.created_at,
      })
      .execute();
  }

  private async applyActionDispatch(record: ActionDispatch): Promise<void> {
    const action = await this.db
      .selectFrom("actions")
      .select(["campaign_id", "receipt_body"])
      .where("action_id", "=", record.action_id)
      .executeTakeFirst();
    if (!action)
      throw new ProjectionIntegrityError(
        `dispatch has no action intent: ${record.action_id}`,
      );
    if (action.campaign_id !== record.campaign_id)
      throw new ProjectionIntegrityError(
        `dispatch campaign mismatch: ${record.action_id}`,
      );
    if (action.receipt_body)
      throw new ProjectionIntegrityError(
        `dispatch was recorded after action completion: ${record.action_id}`,
      );
    await this.db
      .insertInto("dispatches")
      .values({
        action_id: record.action_id,
        campaign_id: record.campaign_id,
        operation: record.operation,
        adoption_not_before: record.adoption_not_before,
        created_at: record.created_at,
        body: body(record),
      })
      .execute();
  }

  private async applySandboxAdmission(record: SandboxAdmissionGrant): Promise<void> {
    const action = await this.db
      .selectFrom("actions")
      .select(["campaign_id", "action_kind", "receipt_body"])
      .where("action_id", "=", record.action_id)
      .executeTakeFirst();
    if (action?.action_kind !== "sandbox.create")
      throw new ProjectionIntegrityError(
        `Sandbox admission has no create intent: ${record.action_id}`,
      );
    if (action.campaign_id !== record.campaign_id || action.receipt_body)
      throw new ProjectionIntegrityError(
        `Sandbox admission state is invalid: ${record.action_id}`,
      );
    await this.db
      .insertInto("sandbox_admissions")
      .values({
        action_id: record.action_id,
        campaign_id: record.campaign_id,
        namespace: record.namespace,
        capacity_profile_id: record.capacity_profile_id,
        hardware: record.hardware,
        reserved_provider_requests: record.reserved_provider_requests,
        tokens_remaining: record.tokens_remaining,
        refill_cursor_at: record.refill_cursor_at,
        previous_grant_id: record.previous_grant_id,
        created_at: record.created_at,
        body: body(record),
      })
      .execute();
  }

  private async applySandboxCapacityRelease(
    record: SandboxCapacityRelease,
  ): Promise<void> {
    const grant = await this.db
      .selectFrom("sandbox_admissions")
      .select(["campaign_id", "body"])
      .where("action_id", "=", record.action_id)
      .executeTakeFirst();
    const grantRecord = grant
      ? (JSON.parse(grant.body) as SandboxAdmissionGrant)
      : null;
    if (
      !grant ||
      grant.campaign_id !== record.campaign_id ||
      grantRecord?.record_id !== record.grant_id
    )
      throw new ProjectionIntegrityError(
        `Sandbox capacity release has no matching grant: ${record.action_id}`,
      );
    await this.db
      .insertInto("sandbox_capacity_releases")
      .values({
        action_id: record.action_id,
        campaign_id: record.campaign_id,
        grant_id: record.grant_id,
        release_reason: record.release_reason,
        evidence_record_id: record.evidence_record_id,
        created_at: record.created_at,
        body: body(record),
      })
      .execute();
  }

  private async applyActionReceipt(record: ActionReceipt): Promise<void> {
    const action = await this.db
      .selectFrom("actions")
      .selectAll()
      .where("action_id", "=", record.action_id)
      .executeTakeFirst();
    if (!action)
      throw new ProjectionIntegrityError(`receipt has no intent: ${record.action_id}`);
    if (action.campaign_id !== record.campaign_id)
      throw new ProjectionIntegrityError(
        `receipt campaign mismatch: ${record.action_id}`,
      );
    await this.db
      .updateTable("actions")
      .set({
        receipt_body: body(record),
        outcome: record.outcome,
        observed_state: record.observed_state,
        resource_id: record.resource_id ?? null,
      })
      .where("action_id", "=", record.action_id)
      .execute();
  }

  private async applyActionDisposition(record: ActionDisposition): Promise<void> {
    await this.db
      .insertInto("dispositions")
      .values({
        action_id: record.action_id,
        campaign_id: record.campaign_id,
        task_id: record.task_id,
        record_id: record.record_id,
        source_receipt_id: record.source_receipt_id,
        source_receipt_digest: record.source_receipt_digest,
        close_action_id: record.close_action_id,
        close_receipt_id: record.close_receipt_id,
        close_receipt_digest: record.close_receipt_digest,
        batch_id: record.batch_id,
        batch_digest: record.batch_digest,
        batch_size: record.batch_size,
        effective_outcome: record.effective_outcome,
        effective_observed_state: record.effective_observed_state,
        effective_error_code: record.effective_error_code,
        reason_code: record.reason_code,
        reason: record.reason,
        created_at: record.created_at,
        body: body(record),
      })
      .execute();
  }

  private async applyActionAdvanced(record: ActionAdvanced): Promise<void> {
    const action = await this.db
      .selectFrom("actions")
      .select(["campaign_id", "receipt_body"])
      .where("action_id", "=", record.action_id)
      .executeTakeFirst();
    if (!action?.receipt_body)
      throw new ProjectionIntegrityError(
        `advanced action has no receipt: ${record.action_id}`,
      );
    if (action.campaign_id !== record.campaign_id)
      throw new ProjectionIntegrityError(
        `advanced action campaign mismatch: ${record.action_id}`,
      );
    await this.db
      .insertInto("advancements")
      .values({
        action_id: record.action_id,
        campaign_id: record.campaign_id,
        created_at: record.created_at,
        body: body(record),
      })
      .execute();
  }

  private async applyAttempt(record: AttemptReceipt): Promise<void> {
    const task = await this.db
      .selectFrom("tasks")
      .select("task_id")
      .where("campaign_id", "=", record.campaign_id)
      .where("task_id", "=", record.task_id)
      .executeTakeFirst();
    if (!task)
      throw new ProjectionIntegrityError(
        `attempt has no locked task: ${record.attempt_id}`,
      );
    await this.db
      .insertInto("attempts")
      .values({
        attempt_id: record.attempt_id,
        action_id: record.action_id,
        campaign_id: record.campaign_id,
        task_id: record.task_id,
        outcome: record.outcome,
        replacement_eligible: record.replacement_eligible ? 1 : 0,
        evidence_digest: record.evidence_digest,
        evidence_path: record.evidence_path,
        cost_microusd: record.cost_microusd,
        metrics_body: body(record.metrics),
        created_at: record.created_at,
        body: body(record),
      })
      .execute();
  }

  private async applyTerminal(record: TerminalSelection): Promise<void> {
    const attempt = await this.db
      .selectFrom("attempts")
      .selectAll()
      .where("attempt_id", "=", record.attempt_id)
      .executeTakeFirst();
    if (
      !attempt ||
      attempt.campaign_id !== record.campaign_id ||
      attempt.task_id !== record.task_id ||
      attempt.outcome !== record.outcome
    ) {
      throw new ProjectionIntegrityError(
        `terminal selection does not match attempt: ${record.record_id}`,
      );
    }
    const result = await this.db
      .updateTable("tasks")
      .set({ terminal_outcome: record.outcome, selected_attempt_id: record.attempt_id })
      .where("campaign_id", "=", record.campaign_id)
      .where("task_id", "=", record.task_id)
      .where("terminal_outcome", "is", null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1)
      throw new ProjectionIntegrityError(`task is already terminal: ${record.task_id}`);
  }

  private async applyBudget(record: BudgetEvent): Promise<void> {
    await this.db
      .insertInto("budgets")
      .values({
        record_id: record.record_id,
        campaign_id: record.campaign_id,
        event_kind: record.event_kind,
        amount_microusd: record.amount_microusd,
        created_at: record.created_at,
      })
      .execute();
  }

  private async applyEndpoint(record: EndpointResource): Promise<void> {
    await this.db
      .insertInto("endpoints")
      .values({
        action_id: record.action_id,
        campaign_id: record.campaign_id,
        endpoint_id: record.endpoint_id,
        desired_state: record.desired_state,
        observed_state: record.observed_state,
        ready_replicas: record.ready_replicas,
        cleanup_verified: record.cleanup_verified ? 1 : 0,
        active_hourly_cost_microusd: record.active_hourly_cost_microusd,
        created_at: record.created_at,
      })
      .execute();
  }

  private async applyPublication(record: PublicationReceipt): Promise<void> {
    await this.db
      .insertInto("publications")
      .values({
        publication_id: record.publication_id,
        campaign_id: record.campaign_id,
        status: record.publication_state,
        catalog_digest: record.catalog_digest,
        body: body(record),
        created_at: record.created_at,
      })
      .execute();
  }

  private async applyProfile(record: ProfileObject, digest: string): Promise<void> {
    await this.db
      .insertInto("profiles")
      .values({
        profile_id: digest,
        profile_kind: record.profile_kind,
        name: record.name,
        spec_body: body(record.spec),
        source: "bucket",
        created_at: record.created_at,
      })
      .execute();
  }

  private async applyPromotion(record: ProfilePromotion): Promise<void> {
    await this.db
      .insertInto("promotions")
      .values({
        record_id: record.record_id,
        profile_kind: record.profile_kind,
        alias: record.alias,
        profile_id: record.profile_id,
        state: record.promotion_state,
        created_at: record.created_at,
        body: body(record),
      })
      .execute();
  }

  private async applyAcl(record: OperatorAcl): Promise<void> {
    await this.db
      .insertInto("acls")
      .values({
        record_id: record.record_id,
        created_at: record.created_at,
        body: body(record),
      })
      .execute();
  }

  private async verifyDispositionInvariants(
    store: ImmutableObjectStore,
  ): Promise<void> {
    const dispositions = await this.db
      .selectFrom("dispositions")
      .selectAll()
      .orderBy("created_at")
      .orderBy("record_id")
      .execute();
    const batches = new Map<
      string,
      {
        digest: string;
        size: number;
        campaignId: string;
        taskId: string;
        reasonCode: string;
        reason: string;
        actionIds: string[];
        count: number;
      }
    >();
    for (const row of dispositions) {
      const record = JSON.parse(row.body) as ActionDisposition;
      if (record.actor.role !== "operator")
        throw new ProjectionIntegrityError(
          `disposition actor is not an operator: ${record.record_id}`,
        );
      if (record.record_id !== deterministicId("disposition", record.action_id))
        throw new ProjectionIntegrityError(
          `disposition identity mismatch: ${record.record_id}`,
        );
      const action = await this.db
        .selectFrom("actions")
        .selectAll()
        .where("action_id", "=", record.action_id)
        .executeTakeFirst();
      if (!action || action.campaign_id !== record.campaign_id)
        throw new ProjectionIntegrityError(
          `disposition action mismatch: ${record.record_id}`,
        );
      const task = await this.db
        .selectFrom("tasks")
        .select("task_id")
        .where("campaign_id", "=", record.campaign_id)
        .where("task_id", "=", record.task_id)
        .executeTakeFirst();
      if (!task)
        throw new ProjectionIntegrityError(
          `disposition task mismatch: ${record.record_id}`,
        );
      const intent = JSON.parse(action.intent_body) as ActionIntent;
      const sourceReceipt = action.receipt_body
        ? (JSON.parse(action.receipt_body) as ActionReceipt)
        : null;
      if (
        action.action_kind !== "sandbox.exec" ||
        intent.payload.task_id !== record.task_id ||
        !sourceReceipt ||
        sourceReceipt.record_id !== record.source_receipt_id ||
        sha256(canonicalJson(sourceReceipt)) !== record.source_receipt_digest ||
        sourceReceipt.outcome !== "completed" ||
        sourceReceipt.observed_state !== "suppressed-sandbox-cleanup-ambiguous" ||
        (sourceReceipt.error_code ?? null) !== null
      )
        throw new ProjectionIntegrityError(
          `disposition source receipt mismatch: ${record.record_id}`,
        );
      const dispatch = await this.db
        .selectFrom("dispatches")
        .select("operation")
        .where("action_id", "=", record.action_id)
        .executeTakeFirst();
      const advanced = await this.db
        .selectFrom("advancements")
        .select("action_id")
        .where("action_id", "=", record.action_id)
        .executeTakeFirst();
      if (dispatch?.operation !== "execute" || !advanced)
        throw new ProjectionIntegrityError(
          `disposition action fence mismatch: ${record.record_id}`,
        );
      const createActionId = intent.payload.sandbox_create_action_id;
      const resourceId = intent.payload.resource_id;
      if (typeof createActionId !== "string" || typeof resourceId !== "string")
        throw new ProjectionIntegrityError(
          `disposition ownership is incomplete: ${record.record_id}`,
        );
      if (!historicalDispositionResourceMatches(sourceReceipt.resource_id, resourceId))
        throw new ProjectionIntegrityError(
          `disposition source resource mismatch: ${record.record_id}`,
        );
      const create = await this.db
        .selectFrom("actions")
        .selectAll()
        .where("action_id", "=", createActionId)
        .executeTakeFirst();
      if (
        !create ||
        create.campaign_id !== record.campaign_id ||
        create.action_kind !== "sandbox.create" ||
        create.resource_id !== resourceId
      )
        throw new ProjectionIntegrityError(
          `disposition create action mismatch: ${record.record_id}`,
        );
      const createIntent = JSON.parse(create.intent_body) as ActionIntent;
      if (createIntent.payload.task_id !== record.task_id)
        throw new ProjectionIntegrityError(
          `disposition create task mismatch: ${record.record_id}`,
        );
      const closeRows = await this.db
        .selectFrom("actions")
        .selectAll()
        .where("campaign_id", "=", record.campaign_id)
        .where("action_kind", "=", "sandbox.close")
        .where("receipt_body", "is not", null)
        .execute();
      const eligibleCloses: Array<{
        actionId: string;
        receipt: ActionReceipt;
      }> = [];
      for (const close of closeRows) {
        const closeIntent = JSON.parse(close.intent_body) as ActionIntent;
        const closeReceipt = JSON.parse(close.receipt_body as string) as ActionReceipt;
        if (
          closeIntent.payload.task_id !== record.task_id ||
          closeIntent.payload.sandbox_create_action_id !== createActionId ||
          closeIntent.payload.resource_id !== resourceId ||
          closeReceipt.resource_id !== resourceId ||
          closeReceipt.outcome !== "completed" ||
          !terminalSandboxStates.has(closeReceipt.observed_state.toUpperCase())
        )
          continue;
        const closeAdvanced = await this.db
          .selectFrom("advancements")
          .select("action_id")
          .where("action_id", "=", close.action_id)
          .executeTakeFirst();
        if (closeAdvanced)
          eligibleCloses.push({ actionId: close.action_id, receipt: closeReceipt });
      }
      eligibleCloses.sort(
        (left, right) =>
          left.receipt.created_at.localeCompare(right.receipt.created_at) ||
          left.actionId.localeCompare(right.actionId),
      );
      const selectedClose = eligibleCloses[0];
      if (
        !selectedClose ||
        selectedClose.actionId !== record.close_action_id ||
        selectedClose.receipt.record_id !== record.close_receipt_id ||
        sha256(canonicalJson(selectedClose.receipt)) !== record.close_receipt_digest
      )
        throw new ProjectionIntegrityError(
          `disposition close proof mismatch: ${record.record_id}`,
        );
      const resultPath = sandboxActionResultPath(record.campaign_id, record.action_id);
      const resultPrefix = resultPath.slice(0, -"/result.json".length);
      if ((await store.list(resultPrefix)).some((entry) => entry.key === resultPath))
        throw new ProjectionIntegrityError(
          `disposition action has a durable result: ${record.record_id}`,
        );
      const batch = batches.get(record.batch_id);
      if (
        batch &&
        (batch.digest !== record.batch_digest ||
          batch.size !== record.batch_size ||
          batch.campaignId !== record.campaign_id ||
          batch.taskId !== record.task_id ||
          batch.reasonCode !== record.reason_code ||
          batch.reason !== record.reason)
      )
        throw new ProjectionIntegrityError(
          `disposition batch conflict: ${record.batch_id}`,
        );
      batches.set(record.batch_id, {
        digest: record.batch_digest,
        size: record.batch_size,
        campaignId: record.campaign_id,
        taskId: record.task_id,
        reasonCode: record.reason_code,
        reason: record.reason,
        actionIds: [...(batch?.actionIds ?? []), record.action_id],
        count: (batch?.count ?? 0) + 1,
      });
    }
    for (const [batchId, batch] of batches) {
      if (batch.count > batch.size)
        throw new ProjectionIntegrityError(
          `disposition batch exceeds declared size: ${batchId}`,
        );
      if (
        batch.count === batch.size &&
        sha256(
          canonicalJson({
            action_ids: [...batch.actionIds].sort(),
            reason_code: batch.reasonCode,
            reason: batch.reason,
          }),
        ) !== batch.digest
      )
        throw new ProjectionIntegrityError(
          `disposition batch digest mismatch: ${batchId}`,
        );
    }
  }

  private async verifyInvariants(store: ImmutableObjectStore): Promise<void> {
    await this.verifyDispositionInvariants(store);
    const profileRows = await this.db
      .selectFrom("profiles")
      .select(["profile_id", "profile_kind", "spec_body"])
      .execute();
    const profileKinds = new Map(
      profileRows.map((profile) => [profile.profile_id, profile.profile_kind]),
    );
    const promotionRows = await this.db
      .selectFrom("promotions")
      .select(["record_id", "profile_id", "profile_kind"])
      .execute();
    for (const promotion of promotionRows) {
      const profileKind = profileKinds.get(promotion.profile_id);
      if (!profileKind)
        throw new ProjectionIntegrityError(
          `promotion references missing profile: ${promotion.record_id}`,
        );
      if (profileKind !== promotion.profile_kind)
        throw new ProjectionIntegrityError(
          `promotion profile kind mismatch: ${promotion.record_id}`,
        );
    }
    const capacityProfiles = new Map(
      profileRows
        .filter((profile) => profile.profile_kind === "capacity")
        .map((profile) => [
          profile.profile_id,
          JSON.parse(profile.spec_body) as { start_burst: number },
        ]),
    );
    const grants = await this.db.selectFrom("sandbox_admissions").selectAll().execute();
    for (const grant of grants) {
      const profile = capacityProfiles.get(grant.capacity_profile_id);
      if (!profile)
        throw new ProjectionIntegrityError(
          `Sandbox admission references missing capacity profile: ${grant.action_id}`,
        );
      if (grant.tokens_remaining > profile.start_burst)
        throw new ProjectionIntegrityError(
          `Sandbox admission token state exceeds profile: ${grant.action_id}`,
        );
    }
    const grantsByRecord = new Map(
      grants.map((grant) => [
        grant.body ? (JSON.parse(grant.body) as SandboxAdmissionGrant).record_id : "",
        grant,
      ]),
    );
    const followers = new Map<string, number>();
    for (const grant of grants) {
      if (!grant.previous_grant_id) continue;
      const previous = grantsByRecord.get(grant.previous_grant_id);
      if (!previous || previous.namespace !== grant.namespace)
        throw new ProjectionIntegrityError(
          `Sandbox admission predecessor is invalid: ${grant.action_id}`,
        );
      followers.set(
        grant.previous_grant_id,
        (followers.get(grant.previous_grant_id) ?? 0) + 1,
      );
    }
    if ([...followers.values()].some((count) => count > 1))
      throw new ProjectionIntegrityError("Sandbox admission chain has a fork");
    for (const namespace of new Set(grants.map((grant) => grant.namespace))) {
      const namespaceGrants = grants.filter((grant) => grant.namespace === namespace);
      const tips = namespaceGrants.filter((grant) => {
        const record = JSON.parse(grant.body) as SandboxAdmissionGrant;
        return !followers.has(record.record_id);
      });
      if (tips.length !== 1)
        throw new ProjectionIntegrityError(
          `Sandbox admission chain has ${tips.length} tips: ${namespace}`,
        );
    }
    const releases = await this.db
      .selectFrom("sandbox_capacity_releases")
      .selectAll()
      .execute();
    for (const release of releases) {
      const evidence = await this.db
        .selectFrom("objects")
        .select(["kind", "body"])
        .where("record_id", "=", release.evidence_record_id)
        .executeTakeFirst();
      if (evidence?.kind !== "action.receipt")
        throw new ProjectionIntegrityError(
          `Sandbox capacity release evidence is missing: ${release.action_id}`,
        );
      const receipt = JSON.parse(evidence.body) as ActionReceipt;
      const grant = grantsByRecord.get(release.grant_id);
      if (
        !grant ||
        grant.action_id !== release.action_id ||
        grant.campaign_id !== release.campaign_id
      )
        throw new ProjectionIntegrityError(
          `Sandbox capacity release grant mismatch: ${release.action_id}`,
        );
      if (receipt.campaign_id !== release.campaign_id)
        throw new ProjectionIntegrityError(
          `Sandbox capacity release evidence campaign mismatch: ${release.action_id}`,
        );
      if (release.release_reason === "create_failed") {
        if (
          receipt.action_id !== release.action_id ||
          receipt.resource_id !== null ||
          !["failed", "completed"].includes(receipt.outcome)
        )
          throw new ProjectionIntegrityError(
            `Sandbox failed-create release proof is invalid: ${release.action_id}`,
          );
      } else {
        const close = await this.db
          .selectFrom("actions")
          .select(["action_kind", "intent_body"])
          .where("action_id", "=", receipt.action_id)
          .executeTakeFirst();
        const closeIntent = close
          ? (JSON.parse(close.intent_body) as ActionIntent)
          : null;
        if (
          close?.action_kind !== "sandbox.close" ||
          closeIntent?.payload.sandbox_create_action_id !== release.action_id ||
          receipt.outcome !== "completed" ||
          !terminalSandboxStates.has(receipt.observed_state.toUpperCase())
        )
          throw new ProjectionIntegrityError(
            `Sandbox close release proof is invalid: ${release.action_id}`,
          );
      }
    }

    const campaignRows = await this.db
      .selectFrom("campaigns")
      .select(["campaign_id", "ceiling_microusd"])
      .execute();
    const budgetRows = await this.db
      .selectFrom("budgets")
      .select([
        "campaign_id",
        "event_kind",
        "amount_microusd",
        "created_at",
        "record_id",
      ])
      .orderBy("created_at")
      .orderBy("record_id")
      .execute();
    const budgetState = new Map<
      string,
      { ceiling: number; reserved: number; observed: number }
    >(
      campaignRows.map((campaign) => [
        campaign.campaign_id,
        { ceiling: campaign.ceiling_microusd, reserved: 0, observed: 0 },
      ]),
    );
    for (const event of budgetRows) {
      const state = budgetState.get(event.campaign_id);
      if (!state)
        throw new ProjectionIntegrityError(
          `budget event references missing campaign: ${event.campaign_id}`,
        );
      if (event.event_kind === "reserve") state.reserved += event.amount_microusd;
      else if (event.event_kind === "release") state.reserved -= event.amount_microusd;
      else if (event.event_kind === "reconcile")
        state.observed = Math.max(state.observed, event.amount_microusd);
      if (state.reserved < 0)
        throw new ProjectionIntegrityError(
          `budget release exceeds reservation: ${event.campaign_id}`,
        );
      budgetState.set(event.campaign_id, state);
    }
    const attemptCosts = await this.db
      .selectFrom("attempts")
      .select(({ fn }) => [
        "campaign_id",
        fn.sum<number>("cost_microusd").as("observed"),
      ])
      .groupBy("campaign_id")
      .execute();
    const attemptByCampaign = new Map(
      attemptCosts.map((row) => [row.campaign_id, Number(row.observed ?? 0)]),
    );
    for (const campaignId of attemptByCampaign.keys()) {
      if (!budgetState.has(campaignId))
        throw new ProjectionIntegrityError(
          `attempt references missing campaign: ${campaignId}`,
        );
    }
    const hardwareByCampaign = await this.hardwareObservedByCampaign();
    for (const campaignId of hardwareByCampaign.keys()) {
      if (!budgetState.has(campaignId))
        throw new ProjectionIntegrityError(
          `hardware receipt references missing campaign: ${campaignId}`,
        );
    }
    for (const [campaignId, state] of budgetState) {
      const attempts = attemptByCampaign.get(campaignId) ?? 0;
      const hardware = hardwareByCampaign.get(campaignId) ?? 0;
      state.observed = Math.max(state.observed, attempts + hardware);
    }
    const overBudget = [...budgetState.entries()].find(
      ([, state]) => Math.max(state.reserved, state.observed) > state.ceiling,
    );
    if (overBudget)
      throw new ProjectionIntegrityError(`budget exceeds ceiling: ${overBudget[0]}`);
    const unsafeEndpoint = await this.db
      .selectFrom("endpoints")
      .selectAll()
      .where("cleanup_verified", "=", 1)
      .where("ready_replicas", ">", 0)
      .executeTakeFirst();
    if (unsafeEndpoint)
      throw new ProjectionIntegrityError(
        `cleanup receipt has ready replicas: ${unsafeEndpoint.endpoint_id}`,
      );
  }

  async pendingActions(limit = 32): Promise<ActionIntent[]> {
    const rows = await this.db
      .selectFrom("actions")
      .select("intent_body")
      .where("receipt_body", "is", null)
      .orderBy("created_at")
      .orderBy("action_id")
      .limit(limit)
      .execute();
    return rows.map((row) => JSON.parse(row.intent_body) as ActionIntent);
  }

  async unadvancedActions(
    limit = 32,
  ): Promise<Array<{ intent: ActionIntent; receipt: ActionReceipt }>> {
    const rows = await this.db
      .selectFrom("actions")
      .leftJoin("advancements", "advancements.action_id", "actions.action_id")
      .select(["actions.intent_body", "actions.receipt_body"])
      .where("actions.receipt_body", "is not", null)
      .where("advancements.action_id", "is", null)
      .where(
        sql<boolean>`json_extract(actions.intent_body, '$.actor.role') <> 'migration'`,
      )
      .orderBy("actions.created_at")
      .orderBy("actions.action_id")
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      intent: JSON.parse(row.intent_body) as ActionIntent,
      receipt: JSON.parse(row.receipt_body as string) as ActionReceipt,
    }));
  }

  async pendingDispatchedSandboxExecActions(
    campaignId: string,
    taskId?: string,
    limit = 1_025,
  ): Promise<ActionIntent[]> {
    const rows = await this.db
      .selectFrom("actions")
      .innerJoin("dispatches", "dispatches.action_id", "actions.action_id")
      .select("actions.intent_body")
      .where("actions.campaign_id", "=", campaignId)
      .where("actions.action_kind", "=", "sandbox.exec")
      .where("actions.receipt_body", "is", null)
      .$if(taskId !== undefined, (query) =>
        query.where(
          sql<boolean>`json_extract(actions.intent_body, '$.payload.task_id') = ${taskId}`,
        ),
      )
      .orderBy("actions.created_at")
      .orderBy("actions.action_id")
      .limit(limit)
      .execute();
    return rows.map((row) => JSON.parse(row.intent_body) as ActionIntent);
  }

  async actionDispatch(actionId: string): Promise<Selectable<DispatchRow> | null> {
    return (
      (await this.db
        .selectFrom("dispatches")
        .selectAll()
        .where("action_id", "=", actionId)
        .executeTakeFirst()) ?? null
    );
  }

  async actionAdvanced(actionId: string): Promise<boolean> {
    return Boolean(
      await this.db
        .selectFrom("advancements")
        .select("action_id")
        .where("action_id", "=", actionId)
        .executeTakeFirst(),
    );
  }

  async action(actionId: string): Promise<Selectable<ActionRow> | null> {
    return (
      (await this.db
        .selectFrom("actions")
        .selectAll()
        .where("action_id", "=", actionId)
        .executeTakeFirst()) ?? null
    );
  }

  async sandboxAdmission(actionId: string): Promise<SandboxAdmissionGrant | null> {
    const row = await this.db
      .selectFrom("sandbox_admissions")
      .select("body")
      .where("action_id", "=", actionId)
      .executeTakeFirst();
    return row ? (JSON.parse(row.body) as SandboxAdmissionGrant) : null;
  }

  async sandboxCapacityRelease(
    actionId: string,
  ): Promise<SandboxCapacityRelease | null> {
    const row = await this.db
      .selectFrom("sandbox_capacity_releases")
      .select("body")
      .where("action_id", "=", actionId)
      .executeTakeFirst();
    return row ? (JSON.parse(row.body) as SandboxCapacityRelease) : null;
  }

  async activeSandboxAdmissions(namespace: string): Promise<SandboxAdmissionGrant[]> {
    const rows = await this.db
      .selectFrom("sandbox_admissions")
      .leftJoin(
        "sandbox_capacity_releases",
        "sandbox_capacity_releases.action_id",
        "sandbox_admissions.action_id",
      )
      .select("sandbox_admissions.body")
      .where("sandbox_admissions.namespace", "=", namespace)
      .where("sandbox_capacity_releases.action_id", "is", null)
      .orderBy("sandbox_admissions.created_at")
      .orderBy("sandbox_admissions.action_id")
      .execute();
    return rows.map((row) => JSON.parse(row.body) as SandboxAdmissionGrant);
  }

  async latestSandboxAdmission(
    namespace: string,
  ): Promise<SandboxAdmissionGrant | null> {
    const rows = await this.db
      .selectFrom("sandbox_admissions")
      .select("body")
      .where("namespace", "=", namespace)
      .execute();
    const grants = rows.map((row) => JSON.parse(row.body) as SandboxAdmissionGrant);
    if (grants.length === 0) return null;
    const predecessors = new Set(
      grants
        .map((grant) => grant.previous_grant_id)
        .filter((value): value is string => value !== null),
    );
    const tips = grants.filter((grant) => !predecessors.has(grant.record_id));
    if (tips.length !== 1)
      throw new ProjectionIntegrityError(
        `Sandbox admission chain has ${tips.length} tips: ${namespace}`,
      );
    return tips[0] as SandboxAdmissionGrant;
  }

  async dispatchedSandboxCreateActionIds(): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom("actions")
      .innerJoin("dispatches", "dispatches.action_id", "actions.action_id")
      .select("actions.action_id")
      .where("actions.action_kind", "=", "sandbox.create")
      .execute();
    return new Set(rows.map((row) => row.action_id));
  }

  async campaignPendingSandboxCreateCount(campaignId: string): Promise<number> {
    const row = await this.db
      .selectFrom("actions")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("campaign_id", "=", campaignId)
      .where("action_kind", "=", "sandbox.create")
      .where("receipt_body", "is", null)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async pendingSandboxCreates(limit = 1_024): Promise<ActionIntent[]> {
    const rows = await this.db
      .selectFrom("actions")
      .select("intent_body")
      .where("action_kind", "=", "sandbox.create")
      .where("receipt_body", "is", null)
      .orderBy("created_at")
      .orderBy("action_id")
      .limit(limit)
      .execute();
    return rows.map((row) => JSON.parse(row.intent_body) as ActionIntent);
  }

  async campaignRequest(campaignId: string): Promise<CampaignRequest | null> {
    const row = await this.db
      .selectFrom("campaigns")
      .select("request_body")
      .where("campaign_id", "=", campaignId)
      .executeTakeFirst();
    return row?.request_body ? (JSON.parse(row.request_body) as CampaignRequest) : null;
  }

  async campaignIdForIdempotency(keyDigest: string): Promise<string | null> {
    const rows = await this.db
      .selectFrom("campaigns")
      .select(["campaign_id", "request_body"])
      .execute();
    for (const row of rows) {
      if (!row.request_body) continue;
      const request = JSON.parse(row.request_body) as CampaignRequest;
      if (request.idempotency_key_digest === keyDigest) return row.campaign_id;
    }
    return null;
  }

  async campaignLock(campaignId: string): Promise<CampaignLock | null> {
    const row = await this.db
      .selectFrom("campaigns")
      .select("lock_body")
      .where("campaign_id", "=", campaignId)
      .executeTakeFirst();
    return row?.lock_body ? (JSON.parse(row.lock_body) as CampaignLock) : null;
  }

  async budget(recordId: string): Promise<Selectable<BudgetRow> | null> {
    return (
      (await this.db
        .selectFrom("budgets")
        .selectAll()
        .where("record_id", "=", recordId)
        .executeTakeFirst()) ?? null
    );
  }

  async attemptById(attemptId: string): Promise<Selectable<AttemptRow> | null> {
    return (
      (await this.db
        .selectFrom("attempts")
        .selectAll()
        .where("attempt_id", "=", attemptId)
        .executeTakeFirst()) ?? null
    );
  }

  async attemptForActionTask(
    actionId: string,
    taskId: string,
  ): Promise<Selectable<AttemptRow> | null> {
    return (
      (await this.db
        .selectFrom("attempts")
        .selectAll()
        .where("action_id", "=", actionId)
        .where("task_id", "=", taskId)
        .executeTakeFirst()) ?? null
    );
  }

  async campaignAttempts(campaignId: string): Promise<Selectable<AttemptRow>[]> {
    return this.db
      .selectFrom("attempts")
      .selectAll()
      .where("campaign_id", "=", campaignId)
      .orderBy("created_at")
      .execute();
  }

  async campaignPublication(
    campaignId: string,
  ): Promise<Selectable<PublicationRow> | null> {
    return (
      (await this.db
        .selectFrom("publications")
        .selectAll()
        .where("campaign_id", "=", campaignId)
        .orderBy("created_at", "desc")
        .executeTakeFirst()) ?? null
    );
  }

  async campaigns(limit = 50, offset = 0): Promise<CampaignView[]> {
    const rows = await this.db
      .selectFrom("campaigns")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("campaign_id", "desc")
      .limit(limit)
      .offset(offset)
      .execute();
    return Promise.all(rows.map((row) => this.campaignView(row)));
  }

  async campaign(campaignId: string): Promise<CampaignView | null> {
    const row = await this.db
      .selectFrom("campaigns")
      .selectAll()
      .where("campaign_id", "=", campaignId)
      .executeTakeFirst();
    return row ? this.campaignView(row) : null;
  }

  private async campaignView(row: Selectable<CampaignRow>): Promise<CampaignView> {
    const taskCounts = await this.db
      .selectFrom("tasks")
      .select(({ fn }) => [
        fn.countAll<number>().as("total"),
        fn.count<number>("terminal_outcome").as("terminal"),
      ])
      .where("campaign_id", "=", row.campaign_id)
      .executeTakeFirstOrThrow();
    const successCounts = await this.db
      .selectFrom("tasks")
      .select(({ fn }) => fn.countAll<number>().as("successful"))
      .where("campaign_id", "=", row.campaign_id)
      .where("terminal_outcome", "=", "complete")
      .executeTakeFirstOrThrow();
    const actionCounts = await this.db
      .selectFrom("actions")
      .select(({ fn }) => fn.countAll<number>().as("pending"))
      .where("campaign_id", "=", row.campaign_id)
      .where("receipt_body", "is", null)
      .executeTakeFirstOrThrow();
    const budgets = await this.db
      .selectFrom("budgets")
      .selectAll()
      .where("campaign_id", "=", row.campaign_id)
      .orderBy("created_at", "desc")
      .execute();
    const attemptCost = await this.db
      .selectFrom("attempts")
      .select(({ fn }) => fn.sum<number>("cost_microusd").as("observed"))
      .where("campaign_id", "=", row.campaign_id)
      .executeTakeFirstOrThrow();
    const publication = await this.db
      .selectFrom("publications")
      .select("status")
      .where("campaign_id", "=", row.campaign_id)
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    const endpointRows = await this.db
      .selectFrom("endpoints")
      .selectAll()
      .where("campaign_id", "=", row.campaign_id)
      .orderBy("created_at", "desc")
      .orderBy("action_id", "desc")
      .execute();
    const latestEndpoints = new Map<string, Selectable<EndpointRow>>();
    for (const endpoint of endpointRows) {
      if (!latestEndpoints.has(endpoint.endpoint_id))
        latestEndpoints.set(endpoint.endpoint_id, endpoint);
    }
    const cleanupPending = [...latestEndpoints.values()].some(
      (endpoint) => endpoint.cleanup_verified === 0,
    );
    const total = Number(taskCounts.total);
    const terminal = Number(taskCounts.terminal);
    const successful = Number(successCounts.successful);
    const pending = Number(actionCounts.pending);
    const cancelled = await this.hasCampaignAction(row.campaign_id, "campaign.cancel");
    const reserved = budgets.reduce(
      (sum, item) =>
        item.event_kind === "reserve"
          ? sum + item.amount_microusd
          : item.event_kind === "release"
            ? sum - item.amount_microusd
            : sum,
      0,
    );
    const observed = Math.max(
      Number(attemptCost.observed ?? 0) +
        (await this.hardwareObservedMicrousd(row.campaign_id)),
      budgets
        .filter((item) => item.event_kind === "reconcile")
        .reduce((sum, item) => Math.max(sum, item.amount_microusd), 0),
    );
    let status = "queued";
    if (terminal === total && total > 0)
      status = cancelled
        ? "cancelled"
        : publication?.status === "published" && !cleanupPending
          ? "completed"
          : "publishing";
    else if (pending > 0 || terminal > 0) status = "active";
    return {
      campaign_id: row.campaign_id,
      created_at: row.created_at,
      status,
      ceiling_microusd: row.ceiling_microusd,
      reserved_microusd: reserved,
      observed_microusd: observed,
      total_tasks: total,
      terminal_tasks: terminal,
      successful_tasks: successful,
      pending_actions: pending,
      publication_status: publication?.status ?? null,
      cleanup_pending: cleanupPending,
      cancellation_requested: cancelled,
    };
  }

  async tasks(
    campaignId: string,
    limit?: number,
    offset = 0,
  ): Promise<Selectable<TaskRow>[]> {
    const query = this.db
      .selectFrom("tasks")
      .selectAll()
      .where("campaign_id", "=", campaignId)
      .orderBy("task_id");
    return limit === undefined
      ? query.execute()
      : query.limit(limit).offset(offset).execute();
  }

  async task(
    campaignId: string,
    taskId: string,
  ): Promise<{
    task: Selectable<TaskRow>;
    attempts: Array<Selectable<AttemptRow> & { metrics: Record<string, number> }>;
  } | null> {
    const task = await this.db
      .selectFrom("tasks")
      .selectAll()
      .where("campaign_id", "=", campaignId)
      .where("task_id", "=", taskId)
      .executeTakeFirst();
    if (!task) return null;
    const attempts = await this.db
      .selectFrom("attempts")
      .selectAll()
      .where("campaign_id", "=", campaignId)
      .where("task_id", "=", taskId)
      .orderBy("created_at")
      .execute();
    return {
      task,
      attempts: attempts.map((attempt) => ({
        ...attempt,
        metrics: JSON.parse(attempt.metrics_body) as Record<string, number>,
      })),
    };
  }

  async actionDisposition(actionId: string): Promise<ActionDisposition | null> {
    const row = await this.db
      .selectFrom("dispositions")
      .select("body")
      .where("action_id", "=", actionId)
      .executeTakeFirst();
    return row ? (JSON.parse(row.body) as ActionDisposition) : null;
  }

  async actionDispositionsByBatch(batchId: string): Promise<ActionDisposition[]> {
    const rows = await this.db
      .selectFrom("dispositions")
      .select("body")
      .where("batch_id", "=", batchId)
      .orderBy("action_id")
      .execute();
    return rows.map((row) => JSON.parse(row.body) as ActionDisposition);
  }

  async actionDispositionViews(
    campaignId: string,
    taskId: string,
    limit = 50,
    offset = 0,
  ): Promise<ActionDispositionView[]> {
    const rows = await this.db
      .selectFrom("dispositions")
      .innerJoin("actions", "actions.action_id", "dispositions.action_id")
      .select([
        "dispositions.action_id",
        "dispositions.campaign_id",
        "dispositions.task_id",
        "dispositions.record_id",
        "dispositions.effective_outcome",
        "dispositions.effective_observed_state",
        "dispositions.effective_error_code",
        "dispositions.reason_code",
        "dispositions.batch_id",
        "dispositions.batch_size",
        "dispositions.created_at",
        "dispositions.body",
        "actions.outcome",
        "actions.observed_state",
      ])
      .where("dispositions.campaign_id", "=", campaignId)
      .where("dispositions.task_id", "=", taskId)
      .orderBy("dispositions.created_at")
      .orderBy("dispositions.action_id")
      .limit(limit)
      .offset(offset)
      .execute();
    return rows.map((row) => {
      const disposition = JSON.parse(row.body) as ActionDisposition;
      return {
        action_id: row.action_id,
        campaign_id: row.campaign_id,
        task_id: row.task_id,
        recorded_outcome: row.outcome ?? "unknown",
        recorded_observed_state: row.observed_state ?? "unknown",
        effective_outcome: row.effective_outcome,
        effective_observed_state: row.effective_observed_state,
        effective_error_code: row.effective_error_code,
        reason_code: row.reason_code,
        corrected_at: row.created_at,
        actor_role: disposition.actor.role,
        disposition_record_id: row.record_id,
        batch_id: row.batch_id,
        batch_size: row.batch_size,
      };
    });
  }

  async sandboxLifecycleActions(): Promise<Selectable<ActionRow>[]> {
    return this.db
      .selectFrom("actions")
      .selectAll()
      .where("action_kind", "in", ["sandbox.create", "sandbox.close"])
      .orderBy("created_at", "desc")
      .orderBy("action_id", "desc")
      .execute();
  }

  async actions(limit = 100): Promise<Selectable<ActionRow>[]> {
    return this.db
      .selectFrom("actions")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("action_id", "desc")
      .limit(limit)
      .execute();
  }

  async campaignActions(campaignId: string): Promise<Selectable<ActionRow>[]> {
    return this.db
      .selectFrom("actions")
      .selectAll()
      .where("campaign_id", "=", campaignId)
      .orderBy("created_at", "desc")
      .orderBy("action_id", "desc")
      .execute();
  }

  async retryActionForAttempt(
    campaignId: string,
    priorAttemptId: string,
  ): Promise<Selectable<ActionRow> | null> {
    return (
      (await this.db
        .selectFrom("actions")
        .selectAll()
        .where("campaign_id", "=", campaignId)
        .where("action_kind", "=", "job.launch")
        .where(
          sql<boolean>`json_extract(intent_body, '$.payload.prior_attempt_id') = ${priorAttemptId}`,
        )
        .orderBy("created_at")
        .orderBy("action_id")
        .executeTakeFirst()) ?? null
    );
  }

  async hasCampaignAction(campaignId: string, actionKind: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("actions")
      .select("action_id")
      .where("campaign_id", "=", campaignId)
      .where("action_kind", "=", actionKind)
      .limit(1)
      .executeTakeFirst();
    return Boolean(row);
  }

  private collapseHardwareRows(rows: Selectable<ActionRow>[]): Selectable<ActionRow>[] {
    const latest = new Map<string, Selectable<ActionRow>>();
    for (const row of rows) {
      const key = `${row.campaign_id}:${jobIdentity(row)}`;
      const existing = latest.get(key);
      if (!existing) {
        latest.set(key, row);
        continue;
      }
      if (existing.receipt_body === null && row.receipt_body !== null)
        latest.set(key, row);
    }
    return [...latest.values()];
  }

  private async hardwareObservedByCampaign(): Promise<Map<string, number>> {
    const rows = await this.db
      .selectFrom("actions")
      .selectAll()
      .where("action_kind", "in", [...hardwareActionKinds])
      .orderBy("created_at", "desc")
      .orderBy("action_id", "desc")
      .execute();
    const sums = new Map<string, number>();
    for (const row of this.collapseHardwareRows(rows)) {
      const current = sums.get(row.campaign_id) ?? 0;
      sums.set(row.campaign_id, current + receiptCostMicrousd(row));
    }
    return sums;
  }

  private async hardwareObservedMicrousd(campaignId: string): Promise<number> {
    const rows = await this.db
      .selectFrom("actions")
      .selectAll()
      .where("campaign_id", "=", campaignId)
      .where("action_kind", "in", [...hardwareActionKinds])
      .orderBy("created_at", "desc")
      .orderBy("action_id", "desc")
      .execute();
    return this.collapseHardwareRows(rows).reduce(
      (sum, row) => sum + receiptCostMicrousd(row),
      0,
    );
  }

  /**
   * Returns the latest row per HF Job. In-flight observe/cancel intents have no
   * receipt `resource_id` yet, so identity comes from the intent payload. A
   * pending poll does not replace the last receipt-backed observation.
   * `cost_microusd` is the locked hardware cost on that latest receipt.
   */
  async jobs(
    limit = 100,
    offset = 0,
    campaignId?: string,
  ): Promise<Array<Selectable<ActionRow> & { cost_microusd: number }>> {
    let query = this.db
      .selectFrom("actions")
      .selectAll()
      .where("action_kind", "in", ["job.launch", "job.observe", "job.cancel"]);
    if (campaignId) query = query.where("campaign_id", "=", campaignId);
    const rows = await query
      .orderBy("created_at", "desc")
      .orderBy("action_id", "desc")
      .execute();
    const latest = new Map<string, Selectable<ActionRow>>();
    for (const row of rows) {
      const key = jobIdentity(row);
      const existing = latest.get(key);
      if (!existing) {
        latest.set(key, row);
        continue;
      }
      if (existing.receipt_body === null && row.receipt_body !== null)
        latest.set(key, row);
    }
    return [...latest.values()].slice(offset, offset + limit).map((row) => ({
      ...row,
      cost_microusd: receiptCostMicrousd(row),
    }));
  }

  async endpoints(limit = 100, offset = 0): Promise<Selectable<EndpointRow>[]> {
    const rows = await this.db
      .selectFrom("endpoints")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("action_id", "desc")
      .execute();
    const latest = new Map<string, Selectable<EndpointRow>>();
    for (const row of rows) {
      if (!latest.has(row.endpoint_id)) latest.set(row.endpoint_id, row);
    }
    return [...latest.values()].slice(offset, offset + limit);
  }

  async publications(
    limit?: number,
    offset = 0,
  ): Promise<Selectable<PublicationRow>[]> {
    const query = this.db
      .selectFrom("publications")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("publication_id", "desc");
    return limit === undefined
      ? query.execute()
      : query.limit(limit).offset(offset).execute();
  }

  async approvedProfileAliases(): Promise<PromotedProfile[]> {
    const promotions = await this.db
      .selectFrom("promotions")
      .selectAll()
      .where("state", "=", "approved")
      .orderBy("created_at")
      .orderBy("record_id")
      .execute();
    const latest = new Map<string, Selectable<PromotionRow>>();
    for (const promotion of promotions)
      latest.set(`${promotion.profile_kind}:${promotion.alias}`, promotion);

    const output: PromotedProfile[] = [];
    for (const key of [...latest.keys()].sort()) {
      const promotion = latest.get(key) as Selectable<PromotionRow>;
      const profileRow = await this.db
        .selectFrom("profiles")
        .selectAll()
        .where("profile_id", "=", promotion.profile_id)
        .executeTakeFirst();
      const objectRow = await this.db
        .selectFrom("objects")
        .select("body")
        .where("digest", "=", promotion.profile_id)
        .where("kind", "=", "profile.object")
        .executeTakeFirst();
      if (!profileRow || !objectRow)
        throw new ProjectionIntegrityError(
          `approved promotion references missing profile: ${promotion.record_id}`,
        );
      const profile = validateControlRecord<ProfileObject>(JSON.parse(objectRow.body));
      if (
        profile.kind !== "profile.object" ||
        profile.profile_kind !== promotion.profile_kind ||
        profile.profile_kind !== profileRow.profile_kind ||
        profile.name !== profileRow.name ||
        sha256(canonicalJson(profile)) !== promotion.profile_id
      )
        throw new ProjectionIntegrityError(
          `approved promotion profile identity mismatch: ${promotion.record_id}`,
        );
      output.push({
        alias: promotion.alias,
        profile,
        profile_id: promotion.profile_id,
      });
    }
    return output;
  }

  async profiles(
    limit = 100,
    offset = 0,
  ): Promise<
    Array<
      Selectable<ProfileRow> & { promotion_state: string | null; alias: string | null }
    >
  > {
    const rows = await this.db
      .selectFrom("profiles")
      .selectAll()
      .orderBy("profile_kind")
      .orderBy("name")
      .orderBy("profile_id")
      .limit(limit)
      .offset(offset)
      .execute();
    return Promise.all(
      rows.map(async (row) => {
        const promotion = await this.db
          .selectFrom("promotions")
          .select(["state", "alias"])
          .where("profile_id", "=", row.profile_id)
          .orderBy("created_at", "desc")
          .executeTakeFirst();
        return {
          ...row,
          promotion_state: promotion?.state ?? null,
          alias: promotion?.alias ?? null,
        };
      }),
    );
  }

  async latestAcl(): Promise<OperatorAcl | null> {
    const row = await this.db
      .selectFrom("acls")
      .select("body")
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    return row ? (JSON.parse(row.body) as OperatorAcl) : null;
  }

  async audit(cursor: string | null, limit = 100): Promise<ControlEvent[]> {
    let query = this.db.selectFrom("objects").selectAll();
    if (cursor) {
      const decoded = decodeEventCursor(cursor);
      query = query.where((expression) =>
        expression.or([
          expression("created_at", ">", decoded.occurred_at),
          expression.and([
            expression("created_at", "=", decoded.occurred_at),
            expression("key", ">", decoded.key),
          ]),
        ]),
      );
    }
    const rows = await query
      .orderBy("created_at")
      .orderBy("key")
      .limit(limit)
      .execute();
    const dispositionActionIds = rows
      .filter((row) => row.kind === "action.disposition")
      .map((row) => (JSON.parse(row.body) as ActionDisposition).action_id);
    const recordedActions =
      dispositionActionIds.length > 0
        ? await this.db
            .selectFrom("actions")
            .select(["action_id", "outcome", "observed_state"])
            .where("action_id", "in", dispositionActionIds)
            .execute()
        : [];
    const recordedByAction = new Map(
      recordedActions.map((action) => [action.action_id, action]),
    );
    return rows.map((row) => {
      const data: Record<string, unknown> = {
        key: row.key,
        digest: row.digest,
        record_id: row.record_id,
      };
      if (row.kind === "action.disposition") {
        const disposition = JSON.parse(row.body) as ActionDisposition;
        const recorded = recordedByAction.get(disposition.action_id);
        Object.assign(data, {
          campaign_id: disposition.campaign_id,
          task_id: disposition.task_id,
          action_id: disposition.action_id,
          batch_id: disposition.batch_id,
          corrected: true,
          recorded_outcome: recorded?.outcome ?? "unknown",
          recorded_observed_state: recorded?.observed_state ?? "unknown",
          effective_outcome: disposition.effective_outcome,
          effective_observed_state: disposition.effective_observed_state,
          effective_error_code: disposition.effective_error_code,
          reason_code: disposition.reason_code,
        });
      }
      return {
        id: eventCursor(row.created_at, row.key),
        type: row.kind,
        occurred_at: row.created_at,
        data,
      };
    });
  }

  async close(): Promise<void> {
    await this.db.destroy();
    this.database.close();
  }

  static async reset(path: string): Promise<void> {
    await rm(path, { force: true });
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
  }
}
