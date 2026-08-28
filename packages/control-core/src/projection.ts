import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { setImmediate as scheduleImmediate } from "node:timers";
import type {
  ActionAdvanced,
  ActionDispatch,
  ActionIntent,
  ActionReceipt,
  AttemptReceipt,
  BudgetEvent,
  EndpointResource,
  HarborHFControlRecordV1,
  JobAdmissionGrant,
  JobCapacityRelease,
  OperatorAcl,
  ProfileObject,
  ProfilePromotion,
  PublicationReceipt,
  PublicationSupersession,
  RunLock,
  RunRequest,
  TaskCancellation,
  TaskExhaustion,
  TerminalSelection,
} from "@harbor-hf/contracts";
import {
  ContractValidationError,
  canonicalJson,
  sha256,
  validateControlRecord,
} from "@harbor-hf/contracts";
import Database from "better-sqlite3";
import { Kysely, type Selectable, SqliteDialect, sql } from "kysely";
import {
  attemptAdmissibility,
  requiredPositiveMetrics,
} from "./attempt-admissibility.js";
import { type ControlEvent, decodeEventCursor, eventCursor } from "./events.js";
import { verifyEvidenceReference, verifyWorkerEvidence } from "./evidence.js";
import type { PromotedProfile } from "./profiles.js";
import type { ImmutableObjectStore, ObjectEntry } from "./store.js";

function activeProfileRecord(
  record: Extract<HarborHFControlRecordV1, { kind: "profile.object" }>,
): record is ProfileObject {
  if (
    record.profile_kind !== "model" &&
    record.profile_kind !== "harness" &&
    record.profile_kind !== "deployment"
  )
    return true;
  return (
    (record.spec as unknown as { contract_version?: string }).contract_version === "v1"
  );
}

interface ObjectRow {
  key: string;
  digest: string;
  source_identity: string;
  kind: string;
  record_id: string;
  created_at: string;
  body: string;
}

type EventObjectRow = Selectable<ObjectRow> & { event_order: number };

interface VerifiedObjectEntry extends ObjectEntry {
  digest: string;
}

interface ProjectedObjectEntry extends ObjectEntry {
  digest: string;
}

interface RunRow {
  run_id: string;
  created_at: string;
  request_body: string | null;
  lock_body: string | null;
  ceiling_microusd: number;
}

interface ActionRow {
  action_id: string;
  run_id: string;
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

interface JobRow extends ActionRow {
  launch_action_id: string;
  assigned_tasks: number;
  assigned_task_ids_body: string;
  cost_microusd: number;
  is_replacement: number;
}

interface DispatchRow {
  action_id: string;
  run_id: string;
  operation: string;
  adoption_not_before: string;
  created_at: string;
  body: string;
}

interface AdmissionRow {
  action_id: string;
  run_id: string;
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
  run_id: string;
  grant_id: string;
  release_reason: string;
  evidence_record_id: string;
  created_at: string;
  body: string;
}

interface AdvancementRow {
  action_id: string;
  run_id: string;
  created_at: string;
  body: string;
}

interface TaskRow {
  run_id: string;
  task_id: string;
  input_digest: string;
  terminal_outcome: string | null;
  selected_attempt_id: string | null;
}

interface AttemptRow {
  attempt_id: string;
  action_id: string;
  run_id: string;
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

interface ExhaustionRow {
  record_id: string;
  run_id: string;
  task_id: string;
  source_action_id: string;
  last_attempt_id: string | null;
  attempt_count: number;
  reason: string;
  created_at: string;
  body: string;
}

interface BudgetRow {
  record_id: string;
  run_id: string;
  event_kind: string;
  amount_microusd: number;
  created_at: string;
}

interface EndpointRow {
  action_id: string;
  run_id: string;
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
  run_id: string;
  status: string;
  catalog_digest: string | null;
  body: string;
  created_at: string;
}

interface SupersessionRow {
  record_id: string;
  run_id: string;
  publication_id: string;
  superseded_run_id: string;
  superseded_publication_id: string;
  reason: string;
  created_at: string;
  body: string;
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
  runs: RunRow;
  actions: ActionRow;
  jobs: JobRow;
  dispatches: DispatchRow;
  job_admissions: AdmissionRow;
  job_capacity_releases: CapacityReleaseRow;
  advancements: AdvancementRow;
  tasks: TaskRow;
  attempts: AttemptRow;
  task_exhaustions: ExhaustionRow;
  budgets: BudgetRow;
  endpoints: EndpointRow;
  publications: PublicationRow;
  publication_supersessions: SupersessionRow;
  profiles: ProfileRow;
  promotions: PromotionRow;
  acls: AclRow;
  migrations: MigrationRow;
}

export interface RunView {
  run_id: string;
  created_at: string;
  status: string;
  ceiling_microusd: number;
  reserved_microusd: number;
  observed_microusd: number;
  budget_exceeded: boolean;
  total_tasks: number;
  terminal_tasks: number;
  admissible_tasks: number;
  invalid_selected_tasks: number;
  exhausted_tasks: number;
  successful_tasks: number;
  pending_actions: number;
  replacement_assigned_tasks: number;
  replacement_recorded_tasks: number;
  publication_status: string | null;
  cleanup_pending: boolean;
  cancellation_requested: boolean;
  paused: boolean;
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

const REBUILD_IO_CONCURRENCY = 16;
const PROJECTION_APPLY_BATCH_SIZE = 64;
const RUN_NATIVE_CONTROL_PREFIXES = [
  "control/schema=v1/migrations/",
  "control/schema=v1/operators/",
  "control/schema=v1/profiles/",
  "control/schema=v1/runs/",
] as const;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => scheduleImmediate(resolve));
}

function body(value: unknown): string {
  return canonicalJson(value).trimEnd();
}

function controlEvent(row: EventObjectRow, epoch: string): ControlEvent {
  const record = JSON.parse(row.body) as HarborHFControlRecordV1;
  const data: Record<string, unknown> = {
    key: row.key,
    digest: row.digest,
    record_id: row.record_id,
  };
  for (const field of [
    "run_id",
    "task_id",
    "attempt_id",
    "action_id",
    "action_kind",
    "publication_id",
    "profile_kind",
    "alias",
  ] as const) {
    if (field in record)
      data[field] = (record as unknown as Record<string, unknown>)[field];
  }
  return {
    id: eventCursor(epoch, row.event_order),
    type: row.kind,
    occurred_at: row.created_at,
    data,
  };
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

async function listProjectionEntries(
  store: ImmutableObjectStore,
  prefix?: string,
): Promise<ObjectEntry[]> {
  const prefixes = prefix ? [prefix] : RUN_NATIVE_CONTROL_PREFIXES;
  return (await Promise.all(prefixes.map((value) => store.list(value)))).flat();
}

async function readRebuildObjects(
  store: ImmutableObjectStore,
  entries: readonly ObjectEntry[],
): Promise<Uint8Array[]> {
  const objects: Uint8Array[] = [];
  for (let offset = 0; offset < entries.length; offset += REBUILD_IO_CONCURRENCY) {
    const batch = entries.slice(offset, offset + REBUILD_IO_CONCURRENCY);
    objects.push(...(await Promise.all(batch.map((entry) => store.read(entry.key)))));
  }
  return objects;
}

async function verifyRebuildEvidence(
  store: ImmutableObjectStore,
  records: readonly HarborHFControlRecordV1[],
): Promise<void> {
  for (let offset = 0; offset < records.length; offset += REBUILD_IO_CONCURRENCY) {
    const batch = records.slice(offset, offset + REBUILD_IO_CONCURRENCY);
    await Promise.all(batch.map((record) => verifyAttemptEvidence(store, record)));
  }
}

function validateObjectEntry(entry: ObjectEntry): void {
  if (!Number.isSafeInteger(entry.size) || entry.size < 0)
    throw new ProjectionIntegrityError(`invalid size for ${entry.key}`);
  if (typeof entry.source_identity !== "string" || entry.source_identity.length === 0) {
    throw new ProjectionIntegrityError(`missing source identity for ${entry.key}`);
  }
}

function verifiedEntry(bytes: Uint8Array, entry: ObjectEntry): VerifiedObjectEntry {
  validateObjectEntry(entry);
  if (bytes.byteLength !== entry.size) {
    throw new ProjectionIntegrityError(`size mismatch for ${entry.key}`);
  }
  return { ...entry, digest: sha256(bytes) };
}

function parseRecord(
  bytes: Uint8Array,
  entry: VerifiedObjectEntry,
): HarborHFControlRecordV1 {
  const text = new TextDecoder().decode(bytes);
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

const terminalJobStates = new Set([
  "STOPPED",
  "COMPLETED",
  "CANCELLED",
  "CANCELED",
  "ERROR",
]);

function jobStateIsTerminal(state: string | null): boolean {
  return state !== null && terminalJobStates.has(state.toUpperCase());
}

function assignedTaskIdsFromIntent(intentBody: string): string[] {
  const intent = JSON.parse(intentBody) as ActionIntent;
  return Array.isArray(intent.payload.task_ids) ? intent.payload.task_ids : [];
}

function launchStillRunning(
  launch: Selectable<ActionRow>,
  actions: ReadonlyArray<Selectable<ActionRow>>,
): boolean {
  if (launch.receipt_body === null) return true;
  if (jobStateIsTerminal(launch.observed_state)) return false;
  const receipt = JSON.parse(launch.receipt_body) as ActionReceipt;
  if (receipt.outcome === "failed") return false;
  return !actions.some((action) => {
    if (action.action_kind !== "job.observe" || action.receipt_body === null)
      return false;
    const intent = JSON.parse(action.intent_body) as ActionIntent;
    return (
      intent.payload.launch_action_id === launch.action_id &&
      jobStateIsTerminal(action.observed_state)
    );
  });
}

function latestObservedJobState(
  launch: Selectable<ActionRow>,
  actions: ReadonlyArray<Selectable<ActionRow>>,
): string | null {
  const observes = actions
    .filter((row) => {
      if (row.action_kind !== "job.observe" || row.receipt_body === null) return false;
      const intent = JSON.parse(row.intent_body) as ActionIntent;
      return intent.payload.launch_action_id === launch.action_id;
    })
    .sort((left, right) => {
      if (left.generation !== right.generation)
        return left.generation - right.generation;
      const time = left.created_at.localeCompare(right.created_at);
      return time === 0 ? left.action_id.localeCompare(right.action_id) : time;
    });
  return observes.at(-1)?.observed_state ?? launch.observed_state;
}

function abandonedExecutionLaunch(
  action: Selectable<ActionRow>,
  actions: ReadonlyArray<Selectable<ActionRow>>,
): boolean {
  if (action.action_kind !== "job.launch" || action.receipt_body === null) return false;
  if (action.observed_state?.startsWith("suppressed-")) return false;
  if (launchStillRunning(action, actions)) return false;
  const terminalGeneration = actions.reduce(
    (latest, row) => {
      if (
        row.action_kind !== "job.observe" ||
        row.receipt_body === null ||
        !jobStateIsTerminal(row.observed_state)
      )
        return latest;
      const intent = JSON.parse(row.intent_body) as ActionIntent;
      return intent.payload.launch_action_id === action.action_id
        ? Math.max(latest, row.generation)
        : latest;
    },
    action.observed_state && jobStateIsTerminal(action.observed_state) ? -1 : -2,
  );
  const pendingObservation = actions.some((row) => {
    if (row.action_kind !== "job.observe" || row.receipt_body !== null) return false;
    const intent = JSON.parse(row.intent_body) as ActionIntent;
    const linked =
      intent.payload.launch_action_id === action.action_id ||
      (typeof intent.payload.launch_action_id !== "string" &&
        action.resource_id !== null &&
        row.target === action.resource_id);
    return linked && row.generation > terminalGeneration;
  });
  if (pendingObservation) return false;
  const receipt = JSON.parse(action.receipt_body) as ActionReceipt;
  if (receipt.outcome === "failed") return true;
  return jobStateIsTerminal(latestObservedJobState(action, actions));
}

function jobIdentity(row: Selectable<ActionRow>): string {
  if (row.resource_id) return row.resource_id;
  const intent = JSON.parse(row.intent_body) as ActionIntent;
  const payloadResourceId = intent.payload.resource_id;
  if (typeof payloadResourceId === "string") return payloadResourceId;
  const launchActionId = intent.payload.launch_action_id;
  if (typeof launchActionId === "string") return launchActionId;
  return row.action_id;
}

function jobLaunchActionId(row: Selectable<ActionRow>): string {
  if (row.action_kind === "job.launch") return row.action_id;
  const intent = JSON.parse(row.intent_body) as ActionIntent;
  const launchActionId = intent.payload.launch_action_id;
  if (typeof launchActionId !== "string")
    throw new ProjectionIntegrityError(
      `Job action has no launch action: ${row.action_id}`,
    );
  return launchActionId;
}

function receiptCostMicrousd(row: Selectable<ActionRow>): number {
  if (!row.receipt_body) return 0;
  const receipt = JSON.parse(row.receipt_body) as ActionReceipt;
  return receipt.cost_microusd ?? 0;
}

function jobActionTakesPrecedence(
  candidate: Selectable<ActionRow>,
  current: Selectable<JobRow>,
): boolean {
  const candidateHasReceipt = candidate.receipt_body !== null;
  const currentHasReceipt = current.receipt_body !== null;
  if (candidateHasReceipt !== currentHasReceipt) return candidateHasReceipt;
  const created = candidate.created_at.localeCompare(current.created_at);
  return created !== 0
    ? created > 0
    : candidate.action_id.localeCompare(current.action_id) > 0;
}

function projectedJobStillRunning(
  job: Pick<Selectable<JobRow>, "observed_state" | "receipt_body">,
): boolean {
  if (job.receipt_body === null) return true;
  if (job.observed_state?.startsWith("suppressed-")) return false;
  if (jobStateIsTerminal(job.observed_state)) return false;
  return (JSON.parse(job.receipt_body) as ActionReceipt).outcome !== "failed";
}

const hardwareActionKinds = ["job.launch", "job.observe", "job.cancel"] as const;

function isHardwareActionKind(actionKind: string): boolean {
  return hardwareActionKinds.some((kind) => kind === actionKind);
}

export class Projection {
  private database: Database.Database;
  readonly db: Kysely<DatabaseSchema>;
  private eventEpoch = randomUUID();
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

  eventCursorIsCurrent(cursor: string): boolean {
    return decodeEventCursor(cursor).epoch === this.eventEpoch;
  }

  private async latestEventCursor(): Promise<string | null> {
    const row = await this.db
      .selectFrom("objects")
      .select(sql<number>`rowid`.as("event_order"))
      .orderBy(sql`rowid`, "desc")
      .executeTakeFirst();
    return row ? eventCursor(this.eventEpoch, row.event_order) : null;
  }

  async objectDigest(key: string): Promise<string | null> {
    return (await this.objectMetadata(key))?.digest ?? null;
  }

  private async objectMetadata(
    key: string,
  ): Promise<{ digest: string; source_identity: string } | null> {
    const row = await this.db
      .selectFrom("objects")
      .select(["digest", "source_identity"])
      .where("key", "=", key)
      .executeTakeFirst();
    return row ?? null;
  }

  private async initialize(): Promise<void> {
    await this.db.schema
      .createTable("objects")
      .ifNotExists()
      .addColumn("key", "text", (column) => column.primaryKey())
      .addColumn("digest", "text", (column) => column.notNull())
      .addColumn("source_identity", "text", (column) => column.notNull())
      .addColumn("kind", "text", (column) => column.notNull())
      .addColumn("record_id", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("body", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("runs")
      .ifNotExists()
      .addColumn("run_id", "text", (column) => column.primaryKey())
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
      .addColumn("run_id", "text", (column) => column.notNull())
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
      .createTable("jobs")
      .ifNotExists()
      .addColumn("launch_action_id", "text", (column) => column.primaryKey())
      .addColumn("action_id", "text", (column) => column.notNull())
      .addColumn("run_id", "text", (column) => column.notNull())
      .addColumn("action_kind", "text", (column) => column.notNull())
      .addColumn("generation", "integer", (column) => column.notNull())
      .addColumn("target", "text", (column) => column.notNull())
      .addColumn("intent_body", "text", (column) => column.notNull())
      .addColumn("receipt_body", "text")
      .addColumn("outcome", "text")
      .addColumn("observed_state", "text")
      .addColumn("resource_id", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("assigned_tasks", "integer", (column) => column.notNull())
      .addColumn("assigned_task_ids_body", "text", (column) => column.notNull())
      .addColumn("cost_microusd", "integer", (column) => column.notNull())
      .addColumn("is_replacement", "integer", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("dispatches")
      .ifNotExists()
      .addColumn("action_id", "text", (column) => column.primaryKey())
      .addColumn("run_id", "text", (column) => column.notNull())
      .addColumn("operation", "text", (column) => column.notNull())
      .addColumn("adoption_not_before", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("body", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("job_admissions")
      .ifNotExists()
      .addColumn("action_id", "text", (column) => column.primaryKey())
      .addColumn("run_id", "text", (column) => column.notNull())
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
      .createTable("job_capacity_releases")
      .ifNotExists()
      .addColumn("action_id", "text", (column) => column.primaryKey())
      .addColumn("run_id", "text", (column) => column.notNull())
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
      .addColumn("run_id", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("body", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("tasks")
      .ifNotExists()
      .addColumn("run_id", "text", (column) => column.notNull())
      .addColumn("task_id", "text", (column) => column.notNull())
      .addColumn("input_digest", "text", (column) => column.notNull())
      .addColumn("terminal_outcome", "text")
      .addColumn("selected_attempt_id", "text")
      .addPrimaryKeyConstraint("tasks_pk", ["run_id", "task_id"])
      .execute();
    await this.db.schema
      .createTable("attempts")
      .ifNotExists()
      .addColumn("attempt_id", "text", (column) => column.primaryKey())
      .addColumn("action_id", "text", (column) => column.notNull())
      .addColumn("run_id", "text", (column) => column.notNull())
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
      .createTable("task_exhaustions")
      .ifNotExists()
      .addColumn("record_id", "text", (column) => column.primaryKey())
      .addColumn("run_id", "text", (column) => column.notNull())
      .addColumn("task_id", "text", (column) => column.notNull())
      .addColumn("source_action_id", "text", (column) => column.notNull())
      .addColumn("last_attempt_id", "text")
      .addColumn("attempt_count", "integer", (column) => column.notNull())
      .addColumn("reason", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("body", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("budgets")
      .ifNotExists()
      .addColumn("record_id", "text", (column) => column.primaryKey())
      .addColumn("run_id", "text", (column) => column.notNull())
      .addColumn("event_kind", "text", (column) => column.notNull())
      .addColumn("amount_microusd", "integer", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("endpoints")
      .ifNotExists()
      .addColumn("action_id", "text", (column) => column.primaryKey())
      .addColumn("run_id", "text", (column) => column.notNull())
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
      .addColumn("run_id", "text", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("catalog_digest", "text")
      .addColumn("body", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();
    await this.db.schema
      .createTable("publication_supersessions")
      .ifNotExists()
      .addColumn("record_id", "text", (column) => column.primaryKey())
      .addColumn("run_id", "text", (column) => column.notNull())
      .addColumn("publication_id", "text", (column) => column.notNull())
      .addColumn("superseded_run_id", "text", (column) => column.notNull())
      .addColumn("superseded_publication_id", "text", (column) =>
        column.notNull().unique(),
      )
      .addColumn("reason", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("body", "text", (column) => column.notNull())
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
    await sql`CREATE INDEX IF NOT EXISTS objects_kind_record_idx ON objects(kind, record_id)`.execute(
      this.db,
    );
    await sql`CREATE INDEX IF NOT EXISTS actions_run_idx ON actions(run_id, created_at)`.execute(
      this.db,
    );
    await sql`CREATE INDEX IF NOT EXISTS jobs_page_idx ON jobs(created_at DESC, action_id DESC)`.execute(
      this.db,
    );
    await sql`CREATE INDEX IF NOT EXISTS jobs_run_page_idx ON jobs(run_id, created_at DESC, action_id DESC)`.execute(
      this.db,
    );
    await sql`CREATE INDEX IF NOT EXISTS job_admissions_run_idx ON job_admissions(run_id, created_at)`.execute(
      this.db,
    );
    await sql`CREATE INDEX IF NOT EXISTS job_admissions_namespace_idx ON job_admissions(namespace, created_at)`.execute(
      this.db,
    );
    await sql`CREATE INDEX IF NOT EXISTS attempts_task_idx ON attempts(run_id, task_id, created_at)`.execute(
      this.db,
    );
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS attempts_action_task_idx ON attempts(action_id, task_id)`.execute(
      this.db,
    );
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS task_exhaustions_task_idx ON task_exhaustions(run_id, task_id)`.execute(
      this.db,
    );
  }

  private async clear(): Promise<void> {
    for (const table of [
      "migrations",
      "acls",
      "promotions",
      "profiles",
      "publication_supersessions",
      "publications",
      "endpoints",
      "budgets",
      "task_exhaustions",
      "attempts",
      "tasks",
      "advancements",
      "job_capacity_releases",
      "job_admissions",
      "dispatches",
      "jobs",
      "actions",
      "runs",
      "objects",
    ] as const) {
      await this.db.deleteFrom(table).execute();
    }
  }

  async rebuild(store: ImmutableObjectStore, prefix?: string): Promise<void> {
    // Local row order is rebuilt from immutable objects. A new epoch makes
    // clients with a prior cursor replay instead of skipping an object.
    this.eventEpoch = randomUUID();
    this.state = {
      ...this.state,
      ready: false,
      rebuilding: true,
      integrity_error: null,
    };
    try {
      const entries = (await listProjectionEntries(store, prefix)).sort((left, right) =>
        left.key.localeCompare(right.key),
      );
      const seen = new Set<string>();
      for (const entry of entries) {
        validateObjectEntry(entry);
        if (seen.has(entry.key))
          throw new ProjectionIntegrityError(`duplicate object listing: ${entry.key}`);
        seen.add(entry.key);
      }
      // Fetch immutable objects concurrently, then apply them in deterministic key order.
      const objects = await readRebuildObjects(store, entries);
      await this.clear();
      const parsed = entries.map((entry, index) => {
        const bytes = objects[index];
        if (!bytes)
          throw new ProjectionIntegrityError(`missing prefetched object: ${entry.key}`);
        const verified = verifiedEntry(bytes, entry);
        return { entry: verified, record: parseRecord(bytes, verified) };
      });
      await verifyRebuildEvidence(
        store,
        parsed.map(({ record }) => record),
      );
      const supersessions: Array<{
        entry: VerifiedObjectEntry;
        record: PublicationSupersession;
      }> = [];
      for (const [index, { entry, record }] of parsed.entries()) {
        if (index > 0 && index % PROJECTION_APPLY_BATCH_SIZE === 0)
          await yieldToEventLoop();
        if (record.kind === "publication.supersession")
          supersessions.push({ entry, record });
        else await this.apply(entry, record);
      }
      for (const deferred of supersessions)
        await this.apply(deferred.entry, deferred.record);
      await this.verifyInvariants();
      const rebuiltAt = new Date().toISOString();
      this.state = {
        ready: true,
        rebuilding: false,
        object_count: entries.length,
        last_rebuild_at: rebuiltAt,
        last_sync_at: rebuiltAt,
        event_cursor: await this.latestEventCursor(),
        integrity_error: null,
      };
      // A replacement control process can replay while the previous process is
      // still finishing writes. Catch up until a complete listing adds nothing
      // so startup never writes from a stale admission-chain head.
      while ((await this.sync(store, prefix)).length > 0) {
        await yieldToEventLoop();
      }
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

  async sync(store: ImmutableObjectStore, prefix?: string): Promise<ControlEvent[]> {
    try {
      const entries = (await listProjectionEntries(store, prefix)).sort((left, right) =>
        left.key.localeCompare(right.key),
      );
      const seen = new Set<string>();
      const supersessions: Array<{
        entry: VerifiedObjectEntry;
        record: PublicationSupersession;
      }> = [];
      const ingested: ControlEvent[] = [];
      for (const [index, entry] of entries.entries()) {
        if (index > 0 && index % PROJECTION_APPLY_BATCH_SIZE === 0)
          await yieldToEventLoop();
        validateObjectEntry(entry);
        if (seen.has(entry.key))
          throw new ProjectionIntegrityError(`duplicate object listing: ${entry.key}`);
        seen.add(entry.key);
        const projected = await this.objectMetadata(entry.key);
        if (projected) {
          if (projected.source_identity !== entry.source_identity) {
            throw new ProjectionIntegrityError(
              `source identity mismatch for ${entry.key}`,
            );
          }
          continue;
        }
        const bytes = await store.read(entry.key);
        const verified = verifiedEntry(bytes, entry);
        const record = parseRecord(bytes, verified);
        await verifyAttemptEvidence(store, record);
        if (record.kind === "publication.supersession")
          supersessions.push({ entry: verified, record });
        else {
          await this.apply(verified, record);
          ingested.push(await this.eventForKey(entry.key));
        }
      }
      for (const deferred of supersessions) {
        await this.apply(deferred.entry, deferred.record);
        ingested.push(await this.eventForKey(deferred.entry.key));
      }
      await this.verifyInvariants();
      this.state = {
        ...this.state,
        ready: true,
        rebuilding: false,
        object_count: this.state.object_count + ingested.length,
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
    sourceIdentity: string,
    record: HarborHFControlRecordV1,
  ): Promise<ControlEvent> {
    const entry: ProjectedObjectEntry = {
      key,
      digest,
      size: new TextEncoder().encode(canonicalJson(record)).byteLength,
      source_identity: sourceIdentity,
    };
    validateObjectEntry(entry);
    await this.apply(entry, record);
    await this.verifyInvariants();
    const event = await this.eventForKey(key);
    this.state = {
      ...this.state,
      object_count: this.state.object_count + 1,
      last_sync_at: new Date().toISOString(),
      event_cursor: event.id,
    };
    return event;
  }

  private async eventForKey(key: string): Promise<ControlEvent> {
    const row = await this.db
      .selectFrom("objects")
      .selectAll()
      .select(sql<number>`rowid`.as("event_order"))
      .where("key", "=", key)
      .executeTakeFirstOrThrow();
    return controlEvent(row, this.eventEpoch);
  }

  private async apply(
    entry: ProjectedObjectEntry,
    record: HarborHFControlRecordV1,
  ): Promise<void> {
    await this.db
      .insertInto("objects")
      .values({
        key: entry.key,
        digest: entry.digest,
        source_identity: entry.source_identity,
        kind: record.kind,
        record_id: record.record_id,
        created_at: record.created_at,
        body: body(record),
      })
      .execute();
    switch (record.kind) {
      case "run.request":
        await this.applyRunRequest(record);
        break;
      case "run.lock":
        await this.applyRunLock(record);
        break;
      case "action.intent":
        await this.applyActionIntent(record);
        break;
      case "action.dispatch":
        await this.applyActionDispatch(record);
        break;
      case "job.admission":
        await this.applyJobAdmission(record);
        break;
      case "job.capacity-release":
        await this.applyJobCapacityRelease(record);
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
      case "task.exhaustion":
        await this.applyTaskExhaustion(record);
        break;
      case "task.cancellation":
        await this.applyTaskCancellation(record);
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
      case "publication.supersession":
        await this.applyPublicationSupersession(record);
        break;
      case "profile.object":
        if (activeProfileRecord(record)) await this.applyProfile(record, entry.digest);
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

  private async applyRunRequest(record: RunRequest): Promise<void> {
    await this.db
      .insertInto("runs")
      .values({
        run_id: record.run_id,
        created_at: record.created_at,
        request_body: body(record),
        lock_body: null,
        ceiling_microusd: record.ceiling_microusd,
      })
      .onConflict((conflict) =>
        conflict.column("run_id").doUpdateSet({ request_body: body(record) }),
      )
      .execute();
  }

  private async applyRunLock(record: RunLock): Promise<void> {
    await this.db
      .insertInto("runs")
      .values({
        run_id: record.run_id,
        created_at: record.created_at,
        request_body: null,
        lock_body: body(record),
        ceiling_microusd: record.ceiling_microusd,
      })
      .onConflict((conflict) =>
        conflict.column("run_id").doUpdateSet({
          lock_body: body(record),
          ceiling_microusd: record.ceiling_microusd,
        }),
      )
      .execute();
    for (const task of record.tasks) {
      await this.db
        .insertInto("tasks")
        .values({
          run_id: record.run_id,
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
        run_id: record.run_id,
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
    if (isHardwareActionKind(record.action_kind))
      await this.projectJobAction(record.action_id);
  }

  private async applyActionDispatch(record: ActionDispatch): Promise<void> {
    const action = await this.db
      .selectFrom("actions")
      .select(["run_id", "receipt_body"])
      .where("action_id", "=", record.action_id)
      .executeTakeFirst();
    if (!action)
      throw new ProjectionIntegrityError(
        `dispatch has no action intent: ${record.action_id}`,
      );
    if (action.run_id !== record.run_id)
      throw new ProjectionIntegrityError(`dispatch run mismatch: ${record.action_id}`);
    if (action.receipt_body)
      throw new ProjectionIntegrityError(
        `dispatch was recorded after action completion: ${record.action_id}`,
      );
    await this.db
      .insertInto("dispatches")
      .values({
        action_id: record.action_id,
        run_id: record.run_id,
        operation: record.operation,
        adoption_not_before: record.adoption_not_before,
        created_at: record.created_at,
        body: body(record),
      })
      .execute();
  }

  private async applyJobAdmission(record: JobAdmissionGrant): Promise<void> {
    const action = await this.db
      .selectFrom("actions")
      .select(["run_id", "action_kind", "receipt_body"])
      .where("action_id", "=", record.action_id)
      .executeTakeFirst();
    if (action?.action_kind !== "job.launch")
      throw new ProjectionIntegrityError(
        `Job admission has no launch intent: ${record.action_id}`,
      );
    if (action.run_id !== record.run_id || action.receipt_body)
      throw new ProjectionIntegrityError(
        `Job admission state is invalid: ${record.action_id}`,
      );
    await this.db
      .insertInto("job_admissions")
      .values({
        action_id: record.action_id,
        run_id: record.run_id,
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

  private async applyJobCapacityRelease(record: JobCapacityRelease): Promise<void> {
    const grant = await this.db
      .selectFrom("job_admissions")
      .select(["run_id", "body"])
      .where("action_id", "=", record.action_id)
      .executeTakeFirst();
    const grantRecord = grant ? (JSON.parse(grant.body) as JobAdmissionGrant) : null;
    if (
      !grant ||
      grant.run_id !== record.run_id ||
      grantRecord?.record_id !== record.grant_id
    )
      throw new ProjectionIntegrityError(
        `Job capacity release has no matching grant: ${record.action_id}`,
      );
    await this.db
      .insertInto("job_capacity_releases")
      .values({
        action_id: record.action_id,
        run_id: record.run_id,
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
    if (action.run_id !== record.run_id)
      throw new ProjectionIntegrityError(`receipt run mismatch: ${record.action_id}`);
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
    if (isHardwareActionKind(action.action_kind))
      await this.projectJobAction(record.action_id);
  }

  /**
   * Materializes one latest row per physical Job as action records arrive.
   *
   * Receipt-backed actions take precedence over newer pending polls, matching
   * the durable Job view without reducing the full action history at read time.
   */
  private async projectJobAction(actionId: string): Promise<void> {
    const candidate = await this.db
      .selectFrom("actions")
      .selectAll()
      .where("action_id", "=", actionId)
      .executeTakeFirstOrThrow();

    const launchActionId = jobLaunchActionId(candidate);
    const launch =
      candidate.action_kind === "job.launch"
        ? candidate
        : await this.db
            .selectFrom("actions")
            .selectAll()
            .where("action_id", "=", launchActionId)
            .executeTakeFirst();
    // Immutable object listing order is not action chronology. A launch that
    // sorts later will project this action when the launch itself is applied.
    if (launch?.action_kind !== "job.launch") {
      if (this.state.rebuilding) return;
      throw new ProjectionIntegrityError(
        `Job action has no launch action: ${candidate.action_id}`,
      );
    }

    const current = await this.db
      .selectFrom("jobs")
      .selectAll()
      .where("launch_action_id", "=", launchActionId)
      .executeTakeFirst();
    if (current && !jobActionTakesPrecedence(candidate, current)) return;

    const taskIds = assignedTaskIdsFromIntent(launch.intent_body);
    const launchIntent = JSON.parse(launch.intent_body) as ActionIntent;
    const projected: Selectable<JobRow> = {
      ...candidate,
      launch_action_id: launchActionId,
      assigned_tasks: taskIds.length,
      assigned_task_ids_body: body(taskIds),
      cost_microusd: receiptCostMicrousd(candidate),
      is_replacement: typeof launchIntent.payload.prior_attempt_id === "string" ? 1 : 0,
    };
    await this.db
      .insertInto("jobs")
      .values(projected)
      .onConflict((conflict) =>
        conflict.column("launch_action_id").doUpdateSet(projected),
      )
      .execute();
    if (candidate.action_kind === "job.launch" && !current) {
      const deferred = await this.db
        .selectFrom("actions")
        .select("action_id")
        .where("action_kind", "in", ["job.observe", "job.cancel"])
        .where(
          sql<boolean>`json_extract(intent_body, '$.payload.launch_action_id') = ${launchActionId}`,
        )
        .execute();
      for (const action of deferred) await this.projectJobAction(action.action_id);
    }
  }

  private async applyActionAdvanced(record: ActionAdvanced): Promise<void> {
    const action = await this.db
      .selectFrom("actions")
      .select(["run_id", "receipt_body"])
      .where("action_id", "=", record.action_id)
      .executeTakeFirst();
    if (!action?.receipt_body)
      throw new ProjectionIntegrityError(
        `advanced action has no receipt: ${record.action_id}`,
      );
    if (action.run_id !== record.run_id)
      throw new ProjectionIntegrityError(
        `advanced action run mismatch: ${record.action_id}`,
      );
    await this.db
      .insertInto("advancements")
      .values({
        action_id: record.action_id,
        run_id: record.run_id,
        created_at: record.created_at,
        body: body(record),
      })
      .execute();
  }

  private async applyAttempt(record: AttemptReceipt): Promise<void> {
    const action = await this.db
      .selectFrom("actions")
      .select(["action_kind", "run_id", "intent_body"])
      .where("action_id", "=", record.action_id)
      .executeTakeFirst();
    if (action?.action_kind !== "job.launch" || action.run_id !== record.run_id)
      throw new ProjectionIntegrityError(
        `attempt has no matching Job launch: ${record.attempt_id}`,
      );
    const intent = JSON.parse(action.intent_body) as ActionIntent;
    if (
      (intent.payload.worker_role ?? "execution") !== "execution" ||
      !Array.isArray(intent.payload.task_ids) ||
      intent.payload.task_ids.length !== 1 ||
      intent.payload.task_id !== record.task_id ||
      intent.payload.task_ids[0] !== record.task_id
    )
      throw new ProjectionIntegrityError(
        `attempt Job assignment mismatch: ${record.attempt_id}`,
      );
    const task = await this.db
      .selectFrom("tasks")
      .select("task_id")
      .where("run_id", "=", record.run_id)
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
        run_id: record.run_id,
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
      attempt.run_id !== record.run_id ||
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
      .where("run_id", "=", record.run_id)
      .where("task_id", "=", record.task_id)
      .where((eb) =>
        eb.or([
          eb("terminal_outcome", "is", null),
          eb("terminal_outcome", "=", "infrastructure"),
        ]),
      )
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1)
      throw new ProjectionIntegrityError(`task is already terminal: ${record.task_id}`);
  }

  private async applyTaskExhaustion(record: TaskExhaustion): Promise<void> {
    const source = await this.db
      .selectFrom("actions")
      .select(["action_kind", "run_id", "intent_body"])
      .where("action_id", "=", record.source_action_id)
      .executeTakeFirst();
    if (source?.action_kind !== "job.launch" || source.run_id !== record.run_id)
      throw new ProjectionIntegrityError(
        `task exhaustion has no matching Job launch: ${record.record_id}`,
      );
    let replaceable = false;
    if (record.last_attempt_id === null) {
      const intent = JSON.parse(source.intent_body) as ActionIntent;
      if (
        intent.payload.worker_role !== "preparation" ||
        !Array.isArray(intent.payload.task_ids) ||
        !intent.payload.task_ids.includes(record.task_id)
      )
        throw new ProjectionIntegrityError(
          `preparation exhaustion task mismatch: ${record.record_id}`,
        );
    } else {
      const attempt = await this.db
        .selectFrom("attempts")
        .select(["run_id", "task_id", "action_id", "outcome", "replacement_eligible"])
        .where("attempt_id", "=", record.last_attempt_id)
        .executeTakeFirst();
      if (
        !attempt ||
        attempt.run_id !== record.run_id ||
        attempt.task_id !== record.task_id ||
        attempt.action_id !== record.source_action_id
      )
        throw new ProjectionIntegrityError(
          `task exhaustion does not match attempt: ${record.record_id}`,
        );
      replaceable =
        attempt.outcome === "infrastructure" &&
        Number(attempt.replacement_eligible) > 0;
    }
    await this.db
      .insertInto("task_exhaustions")
      .values({
        record_id: record.record_id,
        run_id: record.run_id,
        task_id: record.task_id,
        source_action_id: record.source_action_id,
        last_attempt_id: record.last_attempt_id,
        attempt_count: record.attempt_count,
        reason: record.reason,
        created_at: record.created_at,
        body: body(record),
      })
      .execute();
    const result = await this.db
      .updateTable("tasks")
      .set({
        terminal_outcome: replaceable ? "infrastructure" : "invalid",
        selected_attempt_id: null,
      })
      .where("run_id", "=", record.run_id)
      .where("task_id", "=", record.task_id)
      .where("terminal_outcome", "is", null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1)
      throw new ProjectionIntegrityError(`task is already terminal: ${record.task_id}`);
  }

  private async applyTaskCancellation(record: TaskCancellation): Promise<void> {
    const source = await this.db
      .selectFrom("actions")
      .select(["action_kind", "run_id", "intent_body"])
      .where("action_id", "=", record.source_action_id)
      .executeTakeFirst();
    if (source?.action_kind !== "run.cancel" || source.run_id !== record.run_id)
      throw new ProjectionIntegrityError(
        `task cancellation has no matching Run cancellation: ${record.record_id}`,
      );
    const intent = JSON.parse(source.intent_body) as ActionIntent;
    if (
      typeof intent.payload.task_id === "string" &&
      intent.payload.task_id !== record.task_id
    )
      throw new ProjectionIntegrityError(
        `task cancellation scope mismatch: ${record.record_id}`,
      );
    const result = await this.db
      .updateTable("tasks")
      .set({ terminal_outcome: "cancelled", selected_attempt_id: null })
      .where("run_id", "=", record.run_id)
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
        run_id: record.run_id,
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
        run_id: record.run_id,
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
        run_id: record.run_id,
        status: record.publication_state,
        catalog_digest: record.catalog_digest,
        body: body(record),
        created_at: record.created_at,
      })
      .execute();
  }

  private async applyPublicationSupersession(
    record: PublicationSupersession,
  ): Promise<void> {
    const current = await this.db
      .selectFrom("publications")
      .select(["run_id"])
      .where("publication_id", "=", record.publication_id)
      .executeTakeFirst();
    const previous = await this.db
      .selectFrom("publications")
      .select(["run_id"])
      .where("publication_id", "=", record.superseded_publication_id)
      .executeTakeFirst();
    if (
      current?.run_id !== record.run_id ||
      previous?.run_id !== record.superseded_run_id
    )
      throw new ProjectionIntegrityError(
        `publication supersession does not match publications: ${record.record_id}`,
      );
    await this.db
      .insertInto("publication_supersessions")
      .values({
        record_id: record.record_id,
        run_id: record.run_id,
        publication_id: record.publication_id,
        superseded_run_id: record.superseded_run_id,
        superseded_publication_id: record.superseded_publication_id,
        reason: record.reason,
        created_at: record.created_at,
        body: body(record),
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
    const source = await this.db
      .selectFrom("objects")
      .select(["kind", "body"])
      .where("digest", "=", record.profile_id)
      .executeTakeFirst();
    if (source?.kind === "profile.object") {
      const profile = JSON.parse(source.body) as Extract<
        HarborHFControlRecordV1,
        { kind: "profile.object" }
      >;
      if (!activeProfileRecord(profile)) return;
    }
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
    const grants = await this.db.selectFrom("job_admissions").selectAll().execute();
    for (const grant of grants) {
      const profile = capacityProfiles.get(grant.capacity_profile_id);
      if (!profile)
        throw new ProjectionIntegrityError(
          `Job admission references missing capacity profile: ${grant.action_id}`,
        );
      if (grant.tokens_remaining > profile.start_burst)
        throw new ProjectionIntegrityError(
          `Job admission token state exceeds profile: ${grant.action_id}`,
        );
    }
    const grantsByRecord = new Map(
      grants.map((grant) => [
        grant.body ? (JSON.parse(grant.body) as JobAdmissionGrant).record_id : "",
        grant,
      ]),
    );
    const followers = new Map<string, number>();
    for (const grant of grants) {
      if (!grant.previous_grant_id) continue;
      const previous = grantsByRecord.get(grant.previous_grant_id);
      if (!previous || previous.namespace !== grant.namespace)
        throw new ProjectionIntegrityError(
          `Job admission predecessor is invalid: ${grant.action_id}`,
        );
      followers.set(
        grant.previous_grant_id,
        (followers.get(grant.previous_grant_id) ?? 0) + 1,
      );
    }
    if ([...followers.values()].some((count) => count > 1))
      throw new ProjectionIntegrityError("Job admission chain has a fork");
    for (const namespace of new Set(grants.map((grant) => grant.namespace))) {
      const namespaceGrants = grants.filter((grant) => grant.namespace === namespace);
      const tips = namespaceGrants.filter((grant) => {
        const record = JSON.parse(grant.body) as JobAdmissionGrant;
        return !followers.has(record.record_id);
      });
      if (tips.length !== 1)
        throw new ProjectionIntegrityError(
          `Job admission chain has ${tips.length} tips: ${namespace}`,
        );
    }
    const hardwareActions = await this.db
      .selectFrom("actions")
      .selectAll()
      .where("action_kind", "in", [...hardwareActionKinds])
      .orderBy("created_at", "desc")
      .orderBy("action_id", "desc")
      .execute();
    const hardwareActionsById = new Map(
      hardwareActions.map((action) => [action.action_id, action]),
    );
    const launchRuns = new Map(
      hardwareActions
        .filter((action) => action.action_kind === "job.launch")
        .map((action) => [action.action_id, action.run_id]),
    );
    for (const action of hardwareActions) {
      if (action.action_kind === "job.launch") continue;
      if (launchRuns.get(jobLaunchActionId(action)) !== action.run_id)
        throw new ProjectionIntegrityError(
          `Job action has no launch action: ${action.action_id}`,
        );
    }
    const releases = await this.db
      .selectFrom("job_capacity_releases")
      .selectAll()
      .execute();
    const receiptObjects = new Map(
      (
        await this.db
          .selectFrom("objects")
          .select(["record_id", "body"])
          .where("kind", "=", "action.receipt")
          .execute()
      ).map((receipt) => [receipt.record_id, receipt]),
    );
    for (const release of releases) {
      const evidence = receiptObjects.get(release.evidence_record_id);
      if (!evidence)
        throw new ProjectionIntegrityError(
          `Job capacity release evidence is missing: ${release.action_id}`,
        );
      const receipt = JSON.parse(evidence.body) as ActionReceipt;
      const grant = grantsByRecord.get(release.grant_id);
      if (
        !grant ||
        grant.action_id !== release.action_id ||
        grant.run_id !== release.run_id
      )
        throw new ProjectionIntegrityError(
          `Job capacity release grant mismatch: ${release.action_id}`,
        );
      if (receipt.run_id !== release.run_id)
        throw new ProjectionIntegrityError(
          `Job capacity release evidence run mismatch: ${release.action_id}`,
        );
      if (release.release_reason === "launch_failed") {
        if (
          receipt.action_id !== release.action_id ||
          receipt.resource_id !== null ||
          !["failed", "completed"].includes(receipt.outcome)
        )
          throw new ProjectionIntegrityError(
            `Job failed-launch release proof is invalid: ${release.action_id}`,
          );
      } else if (release.release_reason === "launch_suppressed") {
        if (
          receipt.action_id !== release.action_id ||
          receipt.resource_id !== null ||
          receipt.outcome !== "completed" ||
          !receipt.observed_state.startsWith("suppressed-")
        )
          throw new ProjectionIntegrityError(
            `Job suppressed-launch release proof is invalid: ${release.action_id}`,
          );
      } else if (
        receipt.outcome !== "completed" ||
        !terminalJobStates.has(receipt.observed_state.toUpperCase())
      )
        throw new ProjectionIntegrityError(
          `Job terminal release proof is invalid: ${release.action_id}`,
        );
      else {
        const evidenceAction = hardwareActionsById.get(receipt.action_id);
        const evidenceIntent = evidenceAction
          ? (JSON.parse(evidenceAction.intent_body) as ActionIntent)
          : null;
        if (
          !evidenceAction ||
          !["job.observe", "job.cancel"].includes(evidenceAction.action_kind) ||
          evidenceIntent?.payload.launch_action_id !== release.action_id
        )
          throw new ProjectionIntegrityError(
            `Job terminal release action is invalid: ${release.action_id}`,
          );
      }
    }

    const runRows = await this.db
      .selectFrom("runs")
      .select(["run_id", "ceiling_microusd"])
      .execute();
    const budgetRows = await this.db
      .selectFrom("budgets")
      .select(["run_id", "event_kind", "amount_microusd", "created_at", "record_id"])
      .orderBy("created_at")
      .orderBy("record_id")
      .execute();
    const budgetState = new Map<
      string,
      { ceiling: number; reserved: number; observed: number }
    >(
      runRows.map((run) => [
        run.run_id,
        { ceiling: run.ceiling_microusd, reserved: 0, observed: 0 },
      ]),
    );
    for (const event of budgetRows) {
      const state = budgetState.get(event.run_id);
      if (!state)
        throw new ProjectionIntegrityError(
          `budget event references missing run: ${event.run_id}`,
        );
      if (event.event_kind === "reserve") state.reserved += event.amount_microusd;
      else if (event.event_kind === "release") state.reserved -= event.amount_microusd;
      else if (event.event_kind === "reconcile")
        state.observed = Math.max(state.observed, event.amount_microusd);
      if (state.reserved < 0)
        throw new ProjectionIntegrityError(
          `budget release exceeds reservation: ${event.run_id}`,
        );
      budgetState.set(event.run_id, state);
    }
    const attemptCosts = await this.db
      .selectFrom("attempts")
      .select(({ fn }) => ["run_id", fn.sum<number>("cost_microusd").as("observed")])
      .groupBy("run_id")
      .execute();
    const attemptByRun = new Map(
      attemptCosts.map((row) => [row.run_id, Number(row.observed ?? 0)]),
    );
    for (const runId of attemptByRun.keys()) {
      if (!budgetState.has(runId))
        throw new ProjectionIntegrityError(`attempt references missing run: ${runId}`);
    }
    const hardwareByRun = new Map<string, number>();
    for (const row of this.collapseHardwareRows(hardwareActions)) {
      const current = hardwareByRun.get(row.run_id) ?? 0;
      hardwareByRun.set(row.run_id, current + receiptCostMicrousd(row));
    }
    for (const runId of hardwareByRun.keys()) {
      if (!budgetState.has(runId))
        throw new ProjectionIntegrityError(
          `hardware receipt references missing run: ${runId}`,
        );
    }
    for (const [runId, state] of budgetState) {
      const attempts = attemptByRun.get(runId) ?? 0;
      const hardware = hardwareByRun.get(runId) ?? 0;
      state.observed = Math.max(state.observed, attempts + hardware);
    }
    const overBudget = [...budgetState.entries()].find(
      ([, state]) => state.reserved > state.ceiling,
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

  async pendingActionCount(actionKind: ActionIntent["action_kind"]): Promise<number> {
    const row = await this.db
      .selectFrom("actions")
      .select(sql<number>`count(*)`.as("count"))
      .where("action_kind", "=", actionKind)
      .where("receipt_body", "is", null)
      .executeTakeFirstOrThrow();
    return row.count;
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

  async jobAdmission(actionId: string): Promise<JobAdmissionGrant | null> {
    const row = await this.db
      .selectFrom("job_admissions")
      .select("body")
      .where("action_id", "=", actionId)
      .executeTakeFirst();
    return row ? (JSON.parse(row.body) as JobAdmissionGrant) : null;
  }

  async jobCapacityRelease(actionId: string): Promise<JobCapacityRelease | null> {
    const row = await this.db
      .selectFrom("job_capacity_releases")
      .select("body")
      .where("action_id", "=", actionId)
      .executeTakeFirst();
    return row ? (JSON.parse(row.body) as JobCapacityRelease) : null;
  }

  async activeJobAdmissions(namespace: string): Promise<JobAdmissionGrant[]> {
    const rows = await this.db
      .selectFrom("job_admissions")
      .leftJoin(
        "job_capacity_releases",
        "job_capacity_releases.action_id",
        "job_admissions.action_id",
      )
      .select("job_admissions.body")
      .where("job_admissions.namespace", "=", namespace)
      .where("job_capacity_releases.action_id", "is", null)
      .orderBy("job_admissions.created_at")
      .orderBy("job_admissions.action_id")
      .execute();
    return rows.map((row) => JSON.parse(row.body) as JobAdmissionGrant);
  }

  async activeJobAdmissionRunUsage(
    namespace: string,
  ): Promise<Array<{ run_id: string; active_jobs: number; max_active_jobs: number }>> {
    const rows = await this.db
      .selectFrom("job_admissions")
      .innerJoin("actions", "actions.action_id", "job_admissions.action_id")
      .leftJoin(
        "job_capacity_releases",
        "job_capacity_releases.action_id",
        "job_admissions.action_id",
      )
      .select([
        "job_admissions.run_id",
        sql<number>`count(*)`.as("active_jobs"),
        sql<
          number | null
        >`min(json_extract(actions.intent_body, '$.payload.max_jobs'))`.as("minimum"),
        sql<
          number | null
        >`max(json_extract(actions.intent_body, '$.payload.max_jobs'))`.as("maximum"),
      ])
      .where("job_admissions.namespace", "=", namespace)
      .where("job_capacity_releases.action_id", "is", null)
      .groupBy("job_admissions.run_id")
      .orderBy("job_admissions.run_id")
      .execute();
    return rows.map((row) => {
      if (row.minimum === null || row.minimum !== row.maximum)
        throw new ProjectionIntegrityError(
          `active Job admissions disagree on the Run limit: ${row.run_id}`,
        );
      return {
        run_id: row.run_id,
        active_jobs: row.active_jobs,
        max_active_jobs: row.minimum,
      };
    });
  }

  async latestJobAdmission(namespace: string): Promise<JobAdmissionGrant | null> {
    const rows = await this.db
      .selectFrom("job_admissions")
      .select("body")
      .where("namespace", "=", namespace)
      .execute();
    const grants = rows.map((row) => JSON.parse(row.body) as JobAdmissionGrant);
    if (grants.length === 0) return null;
    const predecessors = new Set(
      grants
        .map((grant) => grant.previous_grant_id)
        .filter((value): value is string => value !== null),
    );
    const tips = grants.filter((grant) => !predecessors.has(grant.record_id));
    if (tips.length !== 1)
      throw new ProjectionIntegrityError(
        `Job admission chain has ${tips.length} tips: ${namespace}`,
      );
    return tips[0] as JobAdmissionGrant;
  }

  async runRequest(runId: string): Promise<RunRequest | null> {
    const row = await this.db
      .selectFrom("runs")
      .select("request_body")
      .where("run_id", "=", runId)
      .executeTakeFirst();
    return row?.request_body ? (JSON.parse(row.request_body) as RunRequest) : null;
  }

  async runIdForIdempotency(keyDigest: string): Promise<string | null> {
    const rows = await this.db
      .selectFrom("runs")
      .select(["run_id", "request_body"])
      .execute();
    for (const row of rows) {
      if (!row.request_body) continue;
      const request = JSON.parse(row.request_body) as RunRequest;
      if (request.idempotency_key_digest === keyDigest) return row.run_id;
    }
    return null;
  }

  async runLock(runId: string): Promise<RunLock | null> {
    const row = await this.db
      .selectFrom("runs")
      .select("lock_body")
      .where("run_id", "=", runId)
      .executeTakeFirst();
    return row?.lock_body ? (JSON.parse(row.lock_body) as RunLock) : null;
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

  async runAttempts(runId: string): Promise<Selectable<AttemptRow>[]> {
    return this.db
      .selectFrom("attempts")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("created_at")
      .orderBy("task_id")
      .orderBy("attempt_id")
      .execute();
  }

  async publication(publicationId: string): Promise<Selectable<PublicationRow> | null> {
    return (
      (await this.db
        .selectFrom("publications")
        .selectAll()
        .where("publication_id", "=", publicationId)
        .executeTakeFirst()) ?? null
    );
  }

  async runPublication(runId: string): Promise<Selectable<PublicationRow> | null> {
    return (
      (await this.db
        .selectFrom("publications")
        .selectAll()
        .where("run_id", "=", runId)
        .orderBy("created_at", "desc")
        .executeTakeFirst()) ?? null
    );
  }

  async publicationSupersessions(): Promise<Selectable<SupersessionRow>[]> {
    return this.db
      .selectFrom("publication_supersessions")
      .selectAll()
      .orderBy("created_at")
      .execute();
  }

  async publicationSupersession(
    supersededPublicationId: string,
  ): Promise<Selectable<SupersessionRow> | null> {
    return (
      (await this.db
        .selectFrom("publication_supersessions")
        .selectAll()
        .where("superseded_publication_id", "=", supersededPublicationId)
        .executeTakeFirst()) ?? null
    );
  }

  async runPaused(runId: string): Promise<boolean> {
    const lifecycle = await this.db
      .selectFrom("actions")
      .select(["action_kind"])
      .where("run_id", "=", runId)
      .where("action_kind", "in", ["run.pause", "run.resume"])
      .orderBy("created_at", "desc")
      .orderBy("action_id", "desc")
      .executeTakeFirst();
    return lifecycle?.action_kind === "run.pause";
  }

  async launchActionStillRunning(runId: string, actionId: string): Promise<boolean> {
    const actions = await this.runActions(runId);
    const launch = actions.find((action) => action.action_id === actionId);
    if (launch?.action_kind !== "job.launch") return false;
    return launchStillRunning(launch, actions);
  }

  /**
   * Open tasks that were assigned to an execution Job that failed or stopped
   * before those tasks sealed, and that are not on a still-running Job.
   */
  async abandonedUnresolvedTaskIds(runId: string): Promise<string[]> {
    const actions = await this.runActions(runId);
    const open = new Set(
      (await this.tasks(runId))
        .filter((task) => !task.terminal_outcome)
        .map((task) => task.task_id),
    );
    const running = new Set<string>();
    const abandoned = new Set<string>();
    for (const action of actions) {
      if (action.action_kind !== "job.launch") continue;
      const intent = JSON.parse(action.intent_body) as ActionIntent;
      if (intent.payload.worker_role === "preparation") continue;
      const taskIds = Array.isArray(intent.payload.task_ids)
        ? intent.payload.task_ids.filter(
            (taskId): taskId is string => typeof taskId === "string",
          )
        : [];
      if (launchStillRunning(action, actions)) {
        for (const taskId of taskIds) running.add(taskId);
        continue;
      }
      if (!abandonedExecutionLaunch(action, actions)) continue;
      for (const taskId of taskIds) abandoned.add(taskId);
    }
    return [...abandoned].filter((taskId) => open.has(taskId) && !running.has(taskId));
  }

  async taskExhaustion(
    runId: string,
    taskId: string,
  ): Promise<Selectable<ExhaustionRow> | null> {
    return (
      (await this.db
        .selectFrom("task_exhaustions")
        .selectAll()
        .where("run_id", "=", runId)
        .where("task_id", "=", taskId)
        .executeTakeFirst()) ?? null
    );
  }

  async runs(limit = 50, offset = 0): Promise<RunView[]> {
    const rows = await this.db
      .selectFrom("runs")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("run_id", "desc")
      .limit(limit)
      .offset(offset)
      .execute();
    return Promise.all(rows.map((row) => this.runView(row)));
  }

  /**
   * Returns only Runs that can still require reconciliation.
   *
   * Completed history is excluded before the more expensive derived Run views
   * are built. The final status filter handles invalid or cancelled candidates.
   */
  async activeRuns(): Promise<RunView[]> {
    const rows = await this.db
      .selectFrom("runs")
      .selectAll()
      .where(
        sql<boolean>`EXISTS (
          SELECT 1 FROM tasks
          WHERE tasks.run_id = runs.run_id
            AND tasks.terminal_outcome IS NULL
        ) OR EXISTS (
          SELECT 1 FROM actions
          WHERE actions.run_id = runs.run_id
            AND actions.receipt_body IS NULL
        ) OR EXISTS (
          SELECT 1 FROM actions
          LEFT JOIN advancements
            ON advancements.action_id = actions.action_id
          WHERE actions.run_id = runs.run_id
            AND actions.receipt_body IS NOT NULL
            AND advancements.action_id IS NULL
        ) OR EXISTS (
          SELECT 1 FROM endpoints
          WHERE endpoints.run_id = runs.run_id
            AND endpoints.cleanup_verified = 0
        ) OR (
          EXISTS (SELECT 1 FROM tasks WHERE tasks.run_id = runs.run_id)
          AND NOT EXISTS (
            SELECT 1 FROM tasks
            WHERE tasks.run_id = runs.run_id
              AND tasks.terminal_outcome IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM task_exhaustions
            WHERE task_exhaustions.run_id = runs.run_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM publications
            WHERE publications.run_id = runs.run_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM actions
            WHERE actions.run_id = runs.run_id
              AND actions.action_kind = 'run.cancel'
          )
        )`,
      )
      .orderBy("created_at")
      .orderBy("run_id")
      .execute();
    const views = await Promise.all(rows.map((row) => this.runView(row)));
    return views.filter(
      (run) =>
        !["cancelled", "completed", "completed-invalid", "failed"].includes(run.status),
    );
  }

  async run(runId: string): Promise<RunView | null> {
    const row = await this.db
      .selectFrom("runs")
      .selectAll()
      .where("run_id", "=", runId)
      .executeTakeFirst();
    return row ? this.runView(row) : null;
  }

  private async runView(row: Selectable<RunRow>): Promise<RunView> {
    const taskCounts = await this.db
      .selectFrom("tasks")
      .select(({ fn }) => [
        fn.countAll<number>().as("total"),
        fn.count<number>("terminal_outcome").as("terminal"),
      ])
      .where("run_id", "=", row.run_id)
      .executeTakeFirstOrThrow();
    const successCounts = await this.db
      .selectFrom("tasks")
      .select(({ fn }) => fn.countAll<number>().as("successful"))
      .where("run_id", "=", row.run_id)
      .where("terminal_outcome", "=", "complete")
      .executeTakeFirstOrThrow();
    const actionCounts = await this.db
      .selectFrom("actions")
      .select(({ fn }) => fn.countAll<number>().as("pending"))
      .where("run_id", "=", row.run_id)
      .where("receipt_body", "is", null)
      .executeTakeFirstOrThrow();
    const budgets = await this.db
      .selectFrom("budgets")
      .selectAll()
      .where("run_id", "=", row.run_id)
      .orderBy("created_at", "desc")
      .execute();
    const attemptCost = await this.db
      .selectFrom("attempts")
      .select(({ fn }) => fn.sum<number>("cost_microusd").as("observed"))
      .where("run_id", "=", row.run_id)
      .executeTakeFirstOrThrow();
    const publication = await this.db
      .selectFrom("publications")
      .select("status")
      .where("run_id", "=", row.run_id)
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    const endpointRows = await this.db
      .selectFrom("endpoints")
      .selectAll()
      .where("run_id", "=", row.run_id)
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
    const taskRows = await this.db
      .selectFrom("tasks")
      .selectAll()
      .where("run_id", "=", row.run_id)
      .execute();
    const attemptRows = await this.db
      .selectFrom("attempts")
      .select(["attempt_id", "body"])
      .where("run_id", "=", row.run_id)
      .execute();
    const attemptsById = new Map(
      attemptRows.map((attempt) => [
        attempt.attempt_id,
        JSON.parse(attempt.body) as AttemptReceipt,
      ]),
    );
    const lock = row.lock_body ? (JSON.parse(row.lock_body) as RunLock) : null;
    const required = lock ? requiredPositiveMetrics(lock) : [];
    const selected = taskRows.flatMap((task) => {
      const attempt = task.selected_attempt_id
        ? attemptsById.get(task.selected_attempt_id)
        : undefined;
      return attempt ? [attempt] : [];
    });
    const admissible = selected.filter(
      (attempt) => attemptAdmissibility(attempt, required).admissible,
    ).length;
    const invalidSelected = selected.length - admissible;
    const exhaustionCount = await this.db
      .selectFrom("task_exhaustions")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("run_id", "=", row.run_id)
      .executeTakeFirstOrThrow();
    const exhausted = Number(exhaustionCount.count);
    const total = Number(taskCounts.total);
    const terminal = Number(taskCounts.terminal);
    const successful = Number(successCounts.successful);
    const pending = Number(actionCounts.pending);
    const cancellationRows = await this.db
      .selectFrom("actions")
      .select("intent_body")
      .where("run_id", "=", row.run_id)
      .where("action_kind", "=", "run.cancel")
      .execute();
    const cancellations = cancellationRows.map(
      (action) => JSON.parse(action.intent_body) as ActionIntent,
    );
    const globalCancellation = cancellations.some(
      (action) => typeof action.payload.task_id !== "string",
    );
    const scopedCancellationTargets = new Set(
      cancellations.flatMap((action) =>
        typeof action.payload.task_id === "string" ? [action.payload.task_id] : [],
      ),
    );
    const scopedCancellationPending = taskRows.some(
      (task) =>
        scopedCancellationTargets.has(task.task_id) && task.terminal_outcome === null,
    );
    const allTasksCancelled =
      terminal === total &&
      total > 0 &&
      taskRows.every((task) => task.terminal_outcome === "cancelled");
    const cancellationPending =
      cancellations.length > 0 &&
      ((globalCancellation && (terminal < total || pending > 0)) ||
        scopedCancellationPending ||
        (allTasksCancelled && pending > 0));
    const paused = await this.runPaused(row.run_id);
    const replacement = await this.replacementProgress(row.run_id);
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
        (await this.hardwareObservedMicrousd(row.run_id)),
      budgets
        .filter((item) => item.event_kind === "reconcile")
        .reduce((sum, item) => Math.max(sum, item.amount_microusd), 0),
    );
    const budgetExceeded = observed > row.ceiling_microusd;
    let status = "queued";
    if (
      (globalCancellation || allTasksCancelled) &&
      terminal === total &&
      total > 0 &&
      pending === 0
    )
      status = "cancelled";
    else if (cancellationPending) status = "cancelling";
    else if (budgetExceeded) status = "budget-exceeded";
    else if (terminal === total && total > 0 && exhausted > 0) status = "failed";
    else if (terminal === total && total > 0) {
      if (admissible !== total || invalidSelected > 0) status = "completed-invalid";
      else
        status =
          publication?.status === "published" && !cleanupPending
            ? "completed"
            : "publishing";
    } else if (paused) status = "paused";
    else if (pending > 0 || terminal > 0) status = "active";
    return {
      run_id: row.run_id,
      created_at: row.created_at,
      status,
      ceiling_microusd: row.ceiling_microusd,
      reserved_microusd: reserved,
      observed_microusd: observed,
      budget_exceeded: budgetExceeded,
      total_tasks: total,
      terminal_tasks: terminal,
      admissible_tasks: admissible,
      invalid_selected_tasks: invalidSelected,
      exhausted_tasks: exhausted,
      successful_tasks: successful,
      pending_actions: pending,
      replacement_assigned_tasks: replacement.assigned,
      replacement_recorded_tasks: replacement.recorded,
      publication_status: publication?.status ?? null,
      cleanup_pending: cleanupPending,
      cancellation_requested: cancellations.length > 0,
      paused,
    };
  }

  private async replacementProgress(
    runId: string,
  ): Promise<{ assigned: number; recorded: number }> {
    const replacements = await this.db
      .selectFrom("jobs")
      .select([
        "launch_action_id",
        "assigned_task_ids_body",
        "observed_state",
        "receipt_body",
      ])
      .where("run_id", "=", runId)
      .where("is_replacement", "=", 1)
      .execute();
    const running = replacements.filter(projectedJobStillRunning);
    const runningLaunchIds = running.map((job) => job.launch_action_id);
    const assigned = new Set<string>();
    for (const job of running)
      for (const taskId of JSON.parse(job.assigned_task_ids_body) as string[])
        assigned.add(taskId);
    if (assigned.size === 0 || runningLaunchIds.length === 0)
      return { assigned: 0, recorded: 0 };
    const recordedRows = await this.db
      .selectFrom("attempts")
      .select("task_id")
      .where("run_id", "=", runId)
      .where("action_id", "in", runningLaunchIds)
      .execute();
    return {
      assigned: assigned.size,
      recorded: new Set(recordedRows.map((row) => row.task_id)).size,
    };
  }

  async tasks(
    runId: string,
    limit?: number,
    offset = 0,
  ): Promise<Selectable<TaskRow>[]> {
    const query = this.db
      .selectFrom("tasks")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("task_id");
    return limit === undefined
      ? query.execute()
      : query.limit(limit).offset(offset).execute();
  }

  async task(
    runId: string,
    taskId: string,
  ): Promise<{
    task: Selectable<TaskRow>;
    attempts: Array<Selectable<AttemptRow> & { metrics: Record<string, number> }>;
  } | null> {
    const task = await this.db
      .selectFrom("tasks")
      .selectAll()
      .where("run_id", "=", runId)
      .where("task_id", "=", taskId)
      .executeTakeFirst();
    if (!task) return null;
    const attempts = await this.db
      .selectFrom("attempts")
      .selectAll()
      .where("run_id", "=", runId)
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

  async runActions(runId: string): Promise<Selectable<ActionRow>[]> {
    return this.db
      .selectFrom("actions")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("created_at", "desc")
      .orderBy("action_id", "desc")
      .execute();
  }

  async retryActionForAttempt(
    runId: string,
    priorAttemptId: string,
  ): Promise<Selectable<ActionRow> | null> {
    return (
      (await this.db
        .selectFrom("actions")
        .selectAll()
        .where("run_id", "=", runId)
        .where("action_kind", "=", "job.launch")
        .where(
          sql<boolean>`json_extract(intent_body, '$.payload.prior_attempt_id') = ${priorAttemptId}`,
        )
        .orderBy("created_at")
        .orderBy("action_id")
        .executeTakeFirst()) ?? null
    );
  }

  async hasRunAction(runId: string, actionKind: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("actions")
      .select("action_id")
      .where("run_id", "=", runId)
      .where("action_kind", "=", actionKind)
      .limit(1)
      .executeTakeFirst();
    return Boolean(row);
  }

  private collapseHardwareRows(rows: Selectable<ActionRow>[]): Selectable<ActionRow>[] {
    const latest = new Map<string, Selectable<ActionRow>>();
    for (const row of rows) {
      const key = `${row.run_id}:${jobIdentity(row)}`;
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

  private async hardwareObservedMicrousd(runId: string): Promise<number> {
    const rows = await this.db
      .selectFrom("actions")
      .selectAll()
      .where("run_id", "=", runId)
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
   * Returns the materialized latest row per HF Job.
   *
   * Global pages are bounded in SQLite before rows are loaded. A Run-scoped
   * query intentionally returns every projected Job for stable detail views.
   */
  async jobs(
    limit: number | null = 100,
    offset = 0,
    runId?: string,
  ): Promise<
    Array<
      Selectable<ActionRow> & {
        launch_action_id: string;
        cost_microusd: number;
        assigned_tasks: number;
      }
    >
  > {
    let query = this.db.selectFrom("jobs").selectAll();
    if (runId) query = query.where("run_id", "=", runId);
    const ordered = query.orderBy("created_at", "desc").orderBy("action_id", "desc");
    const rows = await (limit === null
      ? offset === 0
        ? ordered
        : ordered.limit(-1).offset(offset)
      : ordered.limit(limit).offset(offset)
    ).execute();
    return rows.map(
      ({ assigned_task_ids_body: _taskIds, is_replacement: _retry, ...row }) => row,
    );
  }

  async activeJobObservedStateCounts(
    namespace: string,
  ): Promise<Record<string, number>> {
    const rows = await this.db
      .selectFrom("job_admissions")
      .innerJoin("jobs", "jobs.launch_action_id", "job_admissions.action_id")
      .leftJoin(
        "job_capacity_releases",
        "job_capacity_releases.action_id",
        "job_admissions.action_id",
      )
      .select(["observed_state", sql<number>`count(*)`.as("count")])
      .where("job_admissions.namespace", "=", namespace)
      .where("job_capacity_releases.action_id", "is", null)
      .groupBy("observed_state")
      .execute();
    return Object.fromEntries(
      rows.map((row) => [row.observed_state ?? "UNOBSERVED", row.count]),
    );
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
    let query = this.db
      .selectFrom("objects")
      .selectAll()
      .select(sql<number>`rowid`.as("event_order"));
    if (cursor) {
      const decoded = decodeEventCursor(cursor);
      if (decoded.epoch === this.eventEpoch)
        query = query.where(sql<boolean>`rowid > ${decoded.order}`);
    }
    const rows = await query.orderBy(sql`rowid`).limit(limit).execute();
    return rows.map((row) => controlEvent(row, this.eventEpoch));
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
