import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ActionAdvanced,
  ActionDispatch,
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
  TerminalSelection,
} from "@harbor-hf/contracts";
import { canonicalJson, sha256, validateControlRecord } from "@harbor-hf/contracts";
import Database from "better-sqlite3";
import { Kysely, type Selectable, SqliteDialect, sql } from "kysely";
import { decodeEventCursor, eventCursor, type ControlEvent } from "./events.js";
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

interface DispatchRow {
  action_id: string;
  campaign_id: string;
  operation: string;
  adoption_not_before: string;
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
  dispatches: DispatchRow;
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
  pending_actions: number;
  publication_status: string | null;
  cleanup_pending: boolean;
}

export interface SystemView {
  ready: boolean;
  rebuilding: boolean;
  object_count: number;
  last_rebuild_at: string | null;
  integrity_error: string | null;
}

export class ProjectionIntegrityError extends Error {}

function body(value: unknown): string {
  return canonicalJson(value).trimEnd();
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
  return validateControlRecord<HarborHFControlRecordV1>(value);
}

export class Projection {
  private database: Database.Database;
  readonly db: Kysely<DatabaseSchema>;
  private state: SystemView = {
    ready: false,
    rebuilding: true,
    object_count: 0,
    last_rebuild_at: null,
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
      "dispatches",
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
        await this.apply(entry, record);
      }
      await this.verifyInvariants();
      this.state = {
        ready: true,
        rebuilding: false,
        object_count: entries.length,
        last_rebuild_at: new Date().toISOString(),
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
        await this.apply(entry, record);
        ingested += 1;
      }
      if (ingested > 0) await this.verifyInvariants();
      this.state = {
        ...this.state,
        ready: true,
        rebuilding: false,
        object_count: this.state.object_count + ingested,
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
  ): Promise<void> {
    const entry = { key, digest, size: canonicalJson(record).length };
    await this.apply(entry, record);
    await this.verifyInvariants();
    this.state = { ...this.state, object_count: this.state.object_count + 1 };
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
      case "action.receipt":
        await this.applyActionReceipt(record);
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

  private async verifyInvariants(): Promise<void> {
    const campaignRows = await this.db
      .selectFrom("campaigns")
      .select(["campaign_id", "ceiling_microusd"])
      .execute();
    const budgetRows = await this.db
      .selectFrom("budgets")
      .select(["campaign_id", "event_kind", "amount_microusd"])
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
    for (const row of attemptCosts) {
      const state = budgetState.get(row.campaign_id);
      if (!state)
        throw new ProjectionIntegrityError(
          `attempt references missing campaign: ${row.campaign_id}`,
        );
      state.observed = Math.max(state.observed, Number(row.observed ?? 0));
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

  async actionDispatch(actionId: string): Promise<Selectable<DispatchRow> | null> {
    return (
      (await this.db
        .selectFrom("dispatches")
        .selectAll()
        .where("action_id", "=", actionId)
        .executeTakeFirst()) ?? null
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

  async campaignRequest(campaignId: string): Promise<CampaignRequest | null> {
    const row = await this.db
      .selectFrom("campaigns")
      .select("request_body")
      .where("campaign_id", "=", campaignId)
      .executeTakeFirst();
    return row?.request_body ? (JSON.parse(row.request_body) as CampaignRequest) : null;
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
    const pending = Number(actionCounts.pending);
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
      Number(attemptCost.observed ?? 0),
      budgets
        .filter((item) => item.event_kind === "reconcile")
        .reduce((sum, item) => Math.max(sum, item.amount_microusd), 0),
    );
    let status = "queued";
    if (terminal === total && total > 0)
      status =
        publication?.status === "published" && !cleanupPending
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
      pending_actions: pending,
      publication_status: publication?.status ?? null,
      cleanup_pending: cleanupPending,
    };
  }

  async tasks(campaignId: string): Promise<Selectable<TaskRow>[]> {
    return this.db
      .selectFrom("tasks")
      .selectAll()
      .where("campaign_id", "=", campaignId)
      .orderBy("task_id")
      .execute();
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

  async actions(limit = 100): Promise<Selectable<ActionRow>[]> {
    return this.db
      .selectFrom("actions")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("action_id", "desc")
      .limit(limit)
      .execute();
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

  async jobs(limit = 100): Promise<Selectable<ActionRow>[]> {
    return this.db
      .selectFrom("actions")
      .selectAll()
      .where("action_kind", "in", ["job.launch", "job.observe", "job.cancel"])
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
  }

  async endpoints(limit = 100): Promise<Selectable<EndpointRow>[]> {
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
    return [...latest.values()].slice(0, limit);
  }

  async publications(limit = 100): Promise<Selectable<PublicationRow>[]> {
    return this.db
      .selectFrom("publications")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
  }

  async profiles(): Promise<
    Array<
      Selectable<ProfileRow> & { promotion_state: string | null; alias: string | null }
    >
  > {
    const rows = await this.db
      .selectFrom("profiles")
      .selectAll()
      .orderBy("profile_kind")
      .orderBy("name")
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
    return rows.map((row) => ({
      id: eventCursor(row.created_at, row.key),
      type: row.kind,
      occurred_at: row.created_at,
      data: {
        key: row.key,
        digest: row.digest,
        record_id: row.record_id,
      },
    }));
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
