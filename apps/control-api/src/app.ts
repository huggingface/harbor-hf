import { existsSync } from "node:fs";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import type {
  Actor,
  AttemptSubmissionV1,
  RunSubmissionV1,
  HarborHFResultCatalogV1,
  PublicationReceipt,
} from "@harbor-hf/contracts";
import {
  canonicalJson,
  deterministicId,
  schemas,
  sha256,
  validateControlRecord,
  validateResultCatalog,
} from "@harbor-hf/contracts";
import {
  ConfirmationRequiredError,
  type ControlEvent,
  ControlNotReadyError,
  IdempotencyConflictError,
  loadLatestLeaderboard,
  PolicyError,
  ProfileResolutionError,
  summarizePublishedResult,
  verifyWorkerCapability,
  type WorkerCapability,
  type WorkerOperation,
} from "@harbor-hf/control-core";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  LogController,
} from "fastify";
import {
  acceptedSchema,
  attemptAcceptedSchema,
  auditSchema,
  runListSchema,
  runViewSchema,
  capacitySchema,
  endpointSchema,
  evidenceAcceptedSchema,
  evidenceUploadSchema,
  itemList,
  jobSchema,
  leaderboardSchema,
  namespaceCapacityPolicySchema,
  namespaceCapacityUpdateSchema,
  profileSchema,
  publicationSchema,
  sessionSchema,
  systemSchema,
  taskDetailSchema,
  taskSchema,
} from "./api-schemas.js";
import {
  type AuthenticatedActor,
  BearerRateLimitError,
  InvalidBearerCredentialError,
  type SessionRow,
  UnauthorizedSubjectError,
} from "./auth.js";
import type { Runtime } from "./runtime.js";

declare module "fastify" {
  interface FastifyRequest {
    actor?: AuthenticatedActor;
    authSession?: SessionRow;
    workerCapability?: WorkerCapability;
  }
}

// Partitioned cookies remain available inside the cross-site Hub iframe without
// becoming shared third-party cookies across unrelated top-level sites.
const embeddedCookiePolicy = {
  partitioned: true,
  sameSite: "none",
  secure: true,
} as const;

function hubJobInspectUrl(namespace: string, jobId: string): string {
  return `https://huggingface.co/jobs/${encodeURIComponent(namespace)}/${encodeURIComponent(jobId)}`;
}

function actor(request: FastifyRequest): AuthenticatedActor {
  if (!request.actor) throw new Error("authenticated actor is missing");
  return request.actor;
}

function domainActor(request: FastifyRequest): Actor {
  if (request.workerCapability)
    return {
      subject: `worker:${request.workerCapability.action_id}`,
      role: "service",
    };
  const authenticated = actor(request);
  return { subject: authenticated.subject, role: authenticated.role };
}

function isWorkerCapabilityRoute(request: FastifyRequest): boolean {
  const path = request.url.split("?", 1)[0] ?? request.url;
  return (
    (request.method === "GET" &&
      (/^\/api\/v1\/runs\/[^/]+$/.test(path) ||
        /^\/api\/v1\/runs\/[^/]+\/(?:lock|prepared-job(?:\/trials\/[^/]+)?)$/.test(
          path,
        ))) ||
    (request.method === "POST" &&
      /^\/api\/v1\/runs\/[^/]+\/(?:prepared-job|tasks\/[^/]+\/attempts)$/.test(path))
  );
}

function isMutation(request: FastifyRequest): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(request.method);
}

class RequestLimiter {
  private windowStartedAt = Date.now();
  private readonly counts = new Map<string, number>();

  allow(key: string, maximum: number, now = Date.now()): boolean {
    if (now - this.windowStartedAt >= 60_000) {
      this.windowStartedAt = now;
      this.counts.clear();
    }
    const count = this.counts.get(key) ?? 0;
    if (count >= maximum) return false;
    if (!this.counts.has(key) && this.counts.size >= 4096) return false;
    this.counts.set(key, count + 1);
    return true;
  }
}

function anonymousRequestLimit(path: string): readonly [string, number] {
  if (path.startsWith("/health/")) return ["anonymous:health", 120];
  if (path === "/auth/login") return ["anonymous:login", 20];
  if (path === "/auth/callback") return ["anonymous:callback", 30];
  if (path === "/auth/logout") return ["anonymous:logout", 30];
  if (path === "/api/v1/auth/session") return ["anonymous:auth-session", 120];
  if (path === "/api/v1/leaderboard") return ["anonymous:leaderboard", 120];
  if (path.startsWith("/api/")) return ["anonymous:api", 240];
  return ["anonymous:static", 600];
}

function isAnonymousLeaderboard(request: FastifyRequest): boolean {
  const path = request.url.split("?", 1)[0] ?? request.url;
  return request.method === "GET" && path === "/api/v1/leaderboard";
}

async function admitRequest(
  limiter: RequestLimiter,
  key: string,
  maximum: number,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (limiter.allow(key, maximum)) return true;
  await reply
    .header("Retry-After", "60")
    .code(429)
    .send({
      error: {
        code: "rate_limit_exceeded",
        message: "request rate limit exceeded",
        request_id: request.id,
      },
    });
  return false;
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 8 || value.length > 256)
    throw new IdempotencyConflictError(
      "Idempotency-Key must contain 8 to 256 characters",
    );
  return value;
}

class WorkerScopeError extends Error {}

function requireWorkerOperation(
  request: FastifyRequest,
  operation: WorkerOperation,
): WorkerCapability {
  const capability = request.workerCapability;
  if (!capability) throw new WorkerScopeError("a worker capability is required");
  if (!capability.operations.includes(operation))
    throw new WorkerScopeError(`worker capability does not authorize ${operation}`);
  return capability;
}

function redactDeploymentTopology<T>(value: T): T {
  const clone = structuredClone(value) as T;
  if (!clone || typeof clone !== "object") return clone;
  const profiles = (clone as { profiles?: unknown }).profiles;
  const candidates = Array.isArray(profiles) ? profiles : [clone];
  for (const profile of candidates) {
    if (!profile || typeof profile !== "object") continue;
    const spec = (profile as { spec?: unknown }).spec;
    if (!spec || typeof spec !== "object") continue;
    const template = (spec as { trial_job_template?: unknown }).trial_job_template;
    if (template && typeof template === "object" && "inference_upstream" in template)
      (template as { inference_upstream?: string }).inference_upstream = "<redacted>";
  }
  return clone;
}

function cursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^\d+$/.test(text)) throw new PolicyError("cursor is invalid");
  const offset = Number(text);
  if (!Number.isSafeInteger(offset) || offset > 1_000_000)
    throw new PolicyError("cursor is outside the bounded result window");
  return offset;
}

function offsetPage<T>(
  values: T[],
  offset: number,
  limit: number,
): { items: T[]; next_cursor: string | null } {
  const items = values.slice(0, limit);
  return {
    items,
    next_cursor:
      values.length > limit
        ? Buffer.from(String(offset + items.length)).toString("base64url")
        : null,
  };
}

const paginationQuerySchema = {
  type: "object",
  properties: {
    cursor: { type: "string", maxLength: 128 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  },
} as const;

const jobsQuerySchema = {
  type: "object",
  description:
    "Global Job listings use offset cursors. When run_id is present, the response contains every latest Job for that Run in one stable, unpaginated page and next_cursor is null.",
  properties: {
    ...paginationQuerySchema.properties,
    run_id: {
      type: "string",
      minLength: 1,
      maxLength: 160,
      description:
        "Return every latest Job for this Run in one response. cursor and limit do not apply.",
    },
  },
} as const;

const resultQuerySchema = {
  type: "object",
  properties: {
    ...paginationQuerySchema.properties,
    model: { type: "string", maxLength: 512 },
    benchmark: { type: "string", maxLength: 512 },
    agent: { type: "string", maxLength: 512 },
    status: { type: "string", maxLength: 80 },
    search: { type: "string", maxLength: 200 },
    published_after: { type: "string", format: "date-time" },
    published_before: { type: "string", format: "date-time" },
    sort: { enum: ["published_at", "model", "benchmark", "status", "score"] },
    order: { enum: ["asc", "desc"] },
  },
} as const;

function cleanSchema(value: object): object {
  const clone = structuredClone(value) as Record<string, unknown>;
  delete clone.$schema;
  delete clone.$id;
  return clone;
}

interface SseEnvelope extends Omit<ControlEvent, "id"> {
  id?: string;
  replay: boolean;
  cursor_reset: boolean;
}

export const SSE_REPLAY_LIMIT = 1_000;
export const SSE_LIVE_BUFFER_LIMIT = 256;

type CursorResetReason =
  | "buffer_limit_exceeded"
  | "epoch_changed"
  | "invalid_cursor"
  | "replay_limit_exceeded";

function sendSseEnvelope(reply: FastifyReply, event: SseEnvelope): boolean {
  if (reply.raw.destroyed || reply.raw.writableEnded) return false;
  const id = event.id ? `id: ${event.id}\n` : "";
  try {
    return reply.raw.write(`${id}data: ${JSON.stringify(event)}\n\n`);
  } catch {
    return false;
  }
}

function waitForSseDrain(reply: FastifyReply): Promise<boolean> {
  const response = reply.raw;
  if (response.destroyed || response.writableEnded) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (drained: boolean) => {
      response.off("drain", onDrain);
      response.off("close", onClosed);
      response.off("error", onClosed);
      resolve(drained);
    };
    const onDrain = () => finish(true);
    const onClosed = () => finish(false);
    response.once("drain", onDrain);
    response.once("close", onClosed);
    response.once("error", onClosed);
    if (response.destroyed || response.writableEnded) finish(false);
  });
}

function cursorResetEnvelope(
  reason: CursorResetReason,
  latestCursor: string | null,
): SseEnvelope {
  return {
    type: "cursor.reset",
    occurred_at: new Date().toISOString(),
    data: {
      reason,
      latest_cursor: latestCursor,
      replay_limit: SSE_REPLAY_LIMIT,
    },
    replay: true,
    cursor_reset: true,
  };
}

function profileString(
  profiles: Array<{ kind: string; profile_id: string; spec: unknown }>,
  kind: string,
  key: string,
): string | null {
  const profile = profiles.find((item) => item.kind === kind);
  if (!profile?.spec || typeof profile.spec !== "object") return null;
  const value = (profile.spec as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

const localPublicationSections = [
  "runs",
  "trials",
  "executions",
  "metrics",
  "artifacts",
] as const;

async function publicationObjectsMatch(
  runtime: Runtime,
  receipt: PublicationReceipt,
): Promise<boolean> {
  if (receipt.object_digests.length !== localPublicationSections.length) return false;
  for (const [index, digest] of receipt.object_digests.entries()) {
    const section = localPublicationSections[index];
    if (!section || !digest.startsWith("sha256:")) return false;
    const key = `results/schema=v1/rows/${section}/${digest.slice("sha256:".length)}.parquet`;
    try {
      if (sha256(await runtime.store.read(key)) !== digest) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function resultItems(runtime: Runtime): Promise<Record<string, unknown>[]> {
  const publications = await runtime.projection.publications();
  const projectedById = new Map(
    publications.map((publication) => [publication.publication_id, publication]),
  );
  const projectedCatalogDigests = new Set(
    publications
      .filter((publication) => publication.status === "published")
      .map((publication) => publication.catalog_digest),
  );
  const byId = new Map<string, Record<string, unknown>>(
    publications
      .filter((publication) => publication.status !== "published")
      .map((publication) => [
        publication.publication_id,
        {
          publication_id: publication.publication_id,
          run_id: publication.run_id,
          status: publication.status,
          catalog_digest: publication.catalog_digest,
          published_at: publication.created_at,
        },
      ]),
  );
  const catalogs = await runtime.store.list("results/schema=v1/catalog");
  for (const object of catalogs) {
    if (!object.key.endsWith(".json")) continue;
    const bytes = await runtime.store.read(object.key);
    if (bytes.byteLength !== object.size)
      throw new Error(`Result catalog size mismatch at ${object.key}`);
    const digest = sha256(bytes);
    let catalog: HarborHFResultCatalogV1;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      catalog = validateResultCatalog<HarborHFResultCatalogV1>(parsed);
    } catch (error) {
      if (projectedCatalogDigests.has(digest)) throw error;
      continue;
    }
    for (const entry of catalog.entries) {
      const projected = projectedById.get(entry.publication_id);
      if (!projected) {
        if (await runtime.projection.run(entry.run_id)) continue;
        byId.set(entry.publication_id, {
          ...entry,
          status: "published",
          catalog_digest: digest,
          catalog_source_digest: catalog.source_digest,
        });
        continue;
      }
      if (projected.status !== "published" || projected.catalog_digest !== digest)
        continue;
      let receipt: PublicationReceipt;
      try {
        const receiptValue = JSON.parse(
          new TextDecoder().decode(await runtime.store.read(entry.result_path)),
        );
        receipt = validateControlRecord<PublicationReceipt>(receiptValue);
      } catch {
        continue;
      }
      if (
        receipt.kind !== "publication.receipt" ||
        receipt.publication_id !== entry.publication_id ||
        receipt.run_id !== entry.run_id ||
        receipt.publication_state !== "published" ||
        receipt.catalog_digest !== digest
      )
        continue;
      let projectedReceipt: PublicationReceipt;
      try {
        projectedReceipt = validateControlRecord<PublicationReceipt>(
          JSON.parse(projected.body),
        );
      } catch {
        continue;
      }
      if (
        canonicalJson(projectedReceipt) !== canonicalJson(receipt) ||
        !(await publicationObjectsMatch(runtime, receipt))
      )
        continue;
      byId.set(entry.publication_id, {
        ...entry,
        status: "published",
        catalog_digest: digest,
        catalog_source_digest: catalog.source_digest,
      });
    }
  }
  for (const supersession of await runtime.projection.publicationSupersessions()) {
    const previous = byId.get(supersession.superseded_publication_id);
    if (!previous) continue;
    previous.status = "superseded";
    previous.superseded_by_publication_id = supersession.publication_id;
  }
  for (const item of byId.values()) {
    const runId = typeof item.run_id === "string" ? item.run_id : null;
    if (!runId) continue;
    const lock = await runtime.projection.runLock(runId);
    if (!lock) continue;
    item.benchmark_revision = profileString(lock.profiles, "benchmark", "revision");
    item.model_revision = profileString(lock.profiles, "model", "revision");
    item.harness_revision = profileString(lock.profiles, "harness", "revision");
    item.agent = profileString(lock.profiles, "harness", "agent");
    item.source_revision = lock.source_revision;
    item.profile_ids = Object.fromEntries(
      lock.profiles.map((profile) => [profile.kind, profile.profile_id]),
    );
  }
  for (const item of byId.values()) {
    const runId = typeof item.run_id === "string" ? item.run_id : null;
    const publicationId =
      typeof item.publication_id === "string" ? item.publication_id : null;
    if (!publicationId) continue;
    const run = runId ? await runtime.projection.run(runId) : null;
    if (run?.status === "completed-invalid" && item.status === "published")
      item.status = "invalid";
    const projectedTasks = runId ? await runtime.projection.tasks(runId) : [];
    const projectedAttempts = runId ? await runtime.projection.runAttempts(runId) : [];
    const summary = summarizePublishedResult({
      bucketId: runtime.config.bucket_id,
      publicationId,
      resultPath: typeof item.result_path === "string" ? item.result_path : null,
      catalogTaskCount: typeof item.task_count === "number" ? item.task_count : null,
      catalogStrictPassCount:
        typeof item.strict_pass_count === "number" ? item.strict_pass_count : null,
      observedCostMicrousd: run?.observed_microusd ?? null,
      tasks: projectedTasks.map((task) => ({
        task_id: task.task_id,
        terminal_outcome: task.terminal_outcome,
        selected_attempt_id: task.selected_attempt_id,
      })),
      attempts: projectedAttempts.map((attempt) => ({
        attempt_id: attempt.attempt_id,
        task_id: attempt.task_id,
        outcome: attempt.outcome,
        cost_microusd: attempt.cost_microusd,
        metrics: JSON.parse(attempt.metrics_body) as Record<string, number>,
      })),
    });
    Object.assign(item, summary);
  }
  return [...byId.values()];
}

interface ResultQuery {
  cursor?: string;
  limit?: number;
  model?: string;
  benchmark?: string;
  agent?: string;
  status?: string;
  search?: string;
  published_after?: string;
  published_before?: string;
  sort?: "published_at" | "model" | "benchmark" | "status" | "score";
  order?: "asc" | "desc";
}

function filterAndSortResults(
  items: Record<string, unknown>[],
  query: ResultQuery,
): Record<string, unknown>[] {
  const needle = query.search?.trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (query.model && item.model !== query.model) return false;
    if (query.benchmark && item.benchmark !== query.benchmark) return false;
    if (query.agent && item.agent !== query.agent && item.harness !== query.agent)
      return false;
    if (query.status && item.status !== query.status) return false;
    const publishedAt = String(item.published_at ?? "");
    if (query.published_after && publishedAt < query.published_after) return false;
    if (query.published_before && publishedAt > query.published_before) return false;
    if (
      needle &&
      ![
        item.publication_id,
        item.run_id,
        item.model,
        item.benchmark,
        item.agent,
        item.harness,
      ].some((value) =>
        String(value ?? "")
          .toLowerCase()
          .includes(needle),
      )
    )
      return false;
    return true;
  });
  const sort = query.sort ?? "published_at";
  const order = query.order === "asc" ? 1 : -1;
  return filtered.sort((left, right) => {
    const leftValue =
      sort === "score"
        ? Number(
            (left.primary_metric as { value?: unknown } | null)?.value ?? -Infinity,
          )
        : String(left[sort] ?? "");
    const rightValue =
      sort === "score"
        ? Number(
            (right.primary_metric as { value?: unknown } | null)?.value ?? -Infinity,
          )
        : String(right[sort] ?? "");
    const comparison =
      typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue));
    return (
      comparison * order ||
      String(right.publication_id).localeCompare(String(left.publication_id))
    );
  });
}

function canarySubmission(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const input = body as Partial<RunSubmissionV1>;
  return (
    input.benchmark === "control-smoke" &&
    input.model === "control-smoke" &&
    input.harness === "control-smoke" &&
    input.launch_policy === "control-smoke" &&
    (input.deployment === undefined ||
      input.deployment === null ||
      input.deployment === "hf-cpu-smoke")
  );
}

export async function buildApp(runtime: Runtime): Promise<FastifyInstance> {
  const app = Fastify({
    ajv: {
      customOptions: {
        allErrors: true,
        allowUnionTypes: true,
        removeAdditional: false,
      },
    },
    bodyLimit: 1024 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => crypto.randomUUID(),
    logger: {
      level: runtime.config.node_env === "test" ? "silent" : "info",
      redact: [
        "req.headers.authorization",
        "req.headers.x-harbor-hf-worker-capability",
        "req.headers.cookie",
        "res.headers.set-cookie",
        "*.HF_TOKEN",
        "*.access_token",
        "*.client_secret",
      ],
    },
    trustProxy: false,
  });
  const requestLimiter = new RequestLimiter();
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'", "https://huggingface.co"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    xFrameOptions: false,
  });
  await app.register(swagger, {
    openapi: {
      info: { title: "Harbor-HF Control API", version: "1.0.0" },
      servers: [{ url: "/" }],
      tags: ["system", "runs", "resources", "results", "audit", "auth"].map((name) => ({
        name,
      })),
    },
  });

  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (path.startsWith("/health/") || path === "/auth/logout") return;
    if (path === "/api/v1/system") return;
    if (!path.startsWith("/api/") && !path.startsWith("/auth/")) return;
    // OAuth role lookup reads the projected ACL. Starting or completing login
    // before replay reaches that ACL would reject an authorized identity.
    if (runtime.ready) return;
    throw new ControlNotReadyError("control runtime is initializing");
  });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && origin !== runtime.config.public_origin) {
      const path = request.url.split("?", 1)[0] ?? request.url;
      const [key, maximum] = anonymousRequestLimit(path);
      if (!(await admitRequest(requestLimiter, key, maximum, request, reply))) return;
      await reply.code(403).send({
        error: {
          code: "origin_rejected",
          message: "cross-origin requests are not allowed",
          request_id: request.id,
        },
      });
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (path.startsWith("/api/v1")) return;
    const [key, maximum] = anonymousRequestLimit(path);
    await admitRequest(requestLimiter, key, maximum, request, reply);
  });

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (!path.startsWith("/api/v1")) return;
    if (path === "/api/v1/system" && !runtime.ready) return;
    if (path === "/api/v1/auth/session") {
      if (runtime.config.auth_mode === "development") {
        await admitRequest(
          requestLimiter,
          "development:operator",
          1000,
          request,
          reply,
        );
        return;
      }
      const sessionId = request.cookies.hhf_session;
      const authenticated = sessionId
        ? await runtime.auth.sessionActor(sessionId)
        : null;
      if (!authenticated) {
        await admitRequest(
          requestLimiter,
          "anonymous:auth-session",
          120,
          request,
          reply,
        );
        return;
      }
      if (
        !(await admitRequest(
          requestLimiter,
          `session:${sha256(authenticated.session.id)}`,
          600,
          request,
          reply,
        ))
      )
        return;
      request.actor = authenticated.actor;
      request.authSession = authenticated.session;
      return;
    }
    const capabilityHeader = request.headers["x-harbor-hf-worker-capability"];
    if (typeof capabilityHeader === "string") {
      if (!isWorkerCapabilityRoute(request)) {
        if (!(await admitRequest(requestLimiter, "anonymous:api", 240, request, reply)))
          return;
        await reply.code(403).send({
          error: {
            code: "worker_scope_rejected",
            message: "the worker capability cannot access this route",
            request_id: request.id,
          },
        });
        return;
      }
      const capability = runtime.config.hf_token
        ? verifyWorkerCapability(
            runtime.config.hf_token,
            capabilityHeader,
            runtime.config.namespace,
          )
        : null;
      if (!capability) {
        if (!(await admitRequest(requestLimiter, "anonymous:api", 240, request, reply)))
          return;
        await reply.code(401).send({
          error: {
            code: "worker_capability_rejected",
            message: "the worker capability is invalid or expired",
            request_id: request.id,
          },
        });
        return;
      }
      if (
        !(await admitRequest(
          requestLimiter,
          `worker:${sha256(capability.action_id)}`,
          2000,
          request,
          reply,
        ))
      )
        return;
      request.workerCapability = capability;
      request.actor = {
        subject: `worker:${capability.action_id}`,
        role: "operator",
        transport: "bearer",
        username: "Run worker",
      };
    } else if (runtime.config.auth_mode === "development") {
      if (
        !(await admitRequest(
          requestLimiter,
          "development:operator",
          1000,
          request,
          reply,
        ))
      )
        return;
      request.actor = runtime.auth.developmentActor();
    } else {
      const authorization = request.headers.authorization;
      if (authorization?.startsWith("Bearer ")) {
        try {
          request.actor = await runtime.auth.bearerActor(
            authorization.slice("Bearer ".length),
          );
        } catch (error) {
          if (error instanceof BearerRateLimitError) {
            await reply
              .header("Retry-After", "60")
              .code(429)
              .send({
                error: {
                  code: "rate_limit_exceeded",
                  message: "bearer identity lookup rate limit exceeded",
                  request_id: request.id,
                },
              });
            return;
          }
          if (!(error instanceof InvalidBearerCredentialError)) throw error;
          if (
            !(await admitRequest(requestLimiter, "anonymous:api", 240, request, reply))
          )
            return;
          await reply.code(401).send({
            error: {
              code: "invalid_bearer_credential",
              message: "the bearer credential is invalid or expired",
              request_id: request.id,
            },
          });
          return;
        }
        if (
          !(await admitRequest(
            requestLimiter,
            `actor:${sha256(request.actor.subject)}`,
            600,
            request,
            reply,
          ))
        )
          return;
      } else {
        const sessionId = request.cookies.hhf_session;
        const authenticated = sessionId
          ? await runtime.auth.sessionActor(sessionId)
          : null;
        if (authenticated) {
          if (
            !(await admitRequest(
              requestLimiter,
              `session:${sha256(authenticated.session.id)}`,
              600,
              request,
              reply,
            ))
          )
            return;
          request.actor = authenticated.actor;
          request.authSession = authenticated.session;
        }
      }
    }
    if (!request.actor) {
      if (isAnonymousLeaderboard(request)) {
        if (
          !(await admitRequest(
            requestLimiter,
            "anonymous:leaderboard",
            120,
            request,
            reply,
          ))
        )
          return;
        return;
      }
      if (!(await admitRequest(requestLimiter, "anonymous:api", 240, request, reply)))
        return;
      await reply.code(401).send({
        error: {
          code: "authentication_required",
          message: "authentication is required",
          request_id: request.id,
        },
      });
      return;
    }
    if (isMutation(request)) {
      if (request.actor.role !== "operator") {
        await reply.code(403).send({
          error: {
            code: "operator_required",
            message: "operator access is required",
            request_id: request.id,
          },
        });
        return;
      }
      if (
        request.actor.transport === "session" &&
        (!request.authSession ||
          !runtime.auth.csrfValid(
            request.authSession,
            request.headers["x-csrf-token"] as string | undefined,
          ))
      ) {
        await reply.code(403).send({
          error: {
            code: "csrf_rejected",
            message: "the CSRF token is missing or invalid",
            request_id: request.id,
          },
        });
      }
    }
  });

  app.get(
    "/health/live",
    {
      schema: { tags: ["system"] },
    },
    async () => ({ status: "live" }),
  );
  app.get(
    "/health/ready",
    {
      schema: {
        tags: ["system"],
        description:
          "Reports control initialization without failing the hosting platform health check.",
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["status"],
            properties: { status: { enum: ["initializing", "ready"] } },
          },
        },
      },
    },
    async () => ({ status: runtime.ready ? "ready" : "initializing" }),
  );

  app.get(
    "/auth/login",
    {
      schema: {
        tags: ["auth"],
        querystring: {
          type: "object",
          properties: { return_to: { type: "string", maxLength: 500 } },
        },
      },
    },
    async (request, reply) => {
      const query = request.query as { return_to?: string };
      const login = await runtime.auth.login(query.return_to ?? "/");
      reply.setCookie("hhf_oauth_flow", login.flow_id, {
        ...embeddedCookiePolicy,
        httpOnly: true,
        path: "/auth/callback",
        maxAge: 600,
      });
      return reply.redirect(login.url.toString());
    },
  );

  app.get(
    "/auth/callback",
    {
      schema: { tags: ["auth"] },
    },
    async (request, reply) => {
      const flowId = request.cookies.hhf_oauth_flow;
      if (!flowId)
        return reply.code(400).send({
          error: {
            code: "oauth_flow_missing",
            message: "OAuth flow cookie is missing",
            request_id: request.id,
          },
        });
      const callback = await runtime.auth.callback(
        flowId,
        new URL(request.url, runtime.config.public_origin),
      );
      reply.clearCookie("hhf_oauth_flow", {
        ...embeddedCookiePolicy,
        path: "/auth/callback",
      });
      reply.setCookie("hhf_session", callback.session_id, {
        ...embeddedCookiePolicy,
        httpOnly: true,
        path: "/",
        expires: new Date(callback.expires_at),
      });
      reply.setCookie("hhf_csrf", callback.csrf, {
        ...embeddedCookiePolicy,
        httpOnly: false,
        path: "/",
        expires: new Date(callback.expires_at),
      });
      return reply.redirect(callback.return_to);
    },
  );

  app.post(
    "/auth/logout",
    {
      schema: { tags: ["auth"] },
    },
    async (request, reply) => {
      const sessionId = request.cookies.hhf_session;
      if (sessionId) runtime.auth.store.deleteSession(sessionId);
      reply.clearCookie("hhf_session", { ...embeddedCookiePolicy, path: "/" });
      reply.clearCookie("hhf_csrf", { ...embeddedCookiePolicy, path: "/" });
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/v1/auth/session",
    {
      schema: { tags: ["auth"], response: { 200: sessionSchema, 401: sessionSchema } },
    },
    async (request, reply) => {
      if (runtime.config.auth_mode === "development") {
        const development = runtime.auth.developmentActor();
        return {
          authenticated: true,
          actor: {
            username: development.username,
            role: development.role,
            transport: development.transport,
          },
        };
      }
      const sessionId = request.cookies.hhf_session;
      const authenticated =
        request.actor && request.authSession
          ? { actor: request.actor, session: request.authSession }
          : sessionId
            ? await runtime.auth.sessionActor(sessionId)
            : null;
      if (!authenticated)
        return reply.code(401).send({ authenticated: false, login_url: "/auth/login" });
      return {
        authenticated: true,
        expires_at: new Date(authenticated.session.expires_at).toISOString(),
        actor: {
          username: authenticated.actor.username,
          role: authenticated.actor.role,
          transport: authenticated.actor.transport,
        },
      };
    },
  );

  app.get(
    "/api/v1/system",
    { schema: { tags: ["system"], response: { 200: systemSchema } } },
    async () => ({
      source_revision: runtime.config.source_revision,
      write_mode: runtime.config.write_mode,
      initialization: {
        ready: runtime.ready,
        status: runtime.ready ? "ready" : "initializing",
      },
      projection: runtime.projection.system(),
      resource_contract: { spaces: 1, buckets: 1, operator_secrets: 2 },
    }),
  );

  app.get(
    "/api/v1/capacity",
    {
      schema: {
        tags: ["system"],
        response: { 200: namespaceCapacityPolicySchema },
      },
    },
    async () => runtime.service.namespaceCapacityPolicy(),
  );

  app.post(
    "/api/v1/capacity",
    {
      schema: {
        tags: ["system"],
        body: namespaceCapacityUpdateSchema,
        response: {
          200: namespaceCapacityPolicySchema,
          503: cleanSchema(schemas.apiError),
        },
      },
    },
    async (request) => {
      if (runtime.config.write_mode === "disabled")
        throw new ControlNotReadyError("capacity writes are disabled before cutover");
      const requestKey = idempotencyKey(request);
      const body = request.body as { max_active_jobs: number; confirmed: true };
      await runtime.service.setMaxActiveJobs(body.max_active_jobs, requestKey);
      return runtime.service.namespaceCapacityPolicy();
    },
  );

  app.get(
    "/api/v1/runs",
    {
      schema: {
        tags: ["runs"],
        querystring: paginationQuerySchema,
        response: { 200: runListSchema },
      },
    },
    async (request) => {
      const query = request.query as { cursor?: string; limit?: number };
      const limit = query.limit ?? 50;
      const offset = cursorOffset(query.cursor);
      const items = await runtime.projection.runs(limit + 1, offset);
      return offsetPage(items, offset, limit);
    },
  );

  app.post(
    "/api/v1/runs",
    {
      schema: {
        tags: ["runs"],
        body: cleanSchema(schemas.runSubmission),
        response: { 202: acceptedSchema },
      },
    },
    async (request, reply) => {
      if (runtime.config.write_mode === "disabled")
        throw new ControlNotReadyError("run writes are disabled before cutover");
      if (runtime.config.write_mode === "canary" && !canarySubmission(request.body))
        throw new PolicyError(
          "canary mode accepts only the built-in control smoke profile",
        );
      const result = await runtime.service.submit(
        request.body,
        idempotencyKey(request),
        domainActor(request),
      );
      reply.header("Location", result.status_url);
      return reply.code(202).send(result);
    },
  );

  app.get(
    "/api/v1/runs/:run_id",
    {
      schema: {
        tags: ["runs"],
        params: {
          type: "object",
          required: ["run_id"],
          properties: { run_id: { type: "string" } },
        },
        response: { 200: runViewSchema, 404: cleanSchema(schemas.apiError) },
      },
    },
    async (request, reply) => {
      const { run_id } = request.params as { run_id: string };
      if (request.workerCapability) {
        requireWorkerOperation(request, "run.read");
        if (request.workerCapability.run_id !== run_id)
          throw new WorkerScopeError(
            "the worker capability does not authorize this run",
          );
      }
      const run = await runtime.projection.run(run_id);
      return (
        run ??
        reply.code(404).send({
          error: {
            code: "not_found",
            message: "run was not found",
            request_id: request.id,
          },
        })
      );
    },
  );

  app.get(
    "/api/v1/runs/:run_id/capacity",
    {
      schema: {
        tags: ["runs"],
        response: { 200: capacitySchema, 404: cleanSchema(schemas.apiError) },
      },
    },
    async (request, reply) => {
      const { run_id } = request.params as { run_id: string };
      if (!(await runtime.projection.run(run_id)))
        return reply.code(404).send({
          error: {
            code: "not_found",
            message: "run was not found",
            request_id: request.id,
          },
        });
      return runtime.service.jobCapacityView(run_id);
    },
  );

  app.get(
    "/api/v1/runs/:run_id/lock",
    {
      schema: {
        tags: ["runs"],
        response: {
          200: { type: "object", additionalProperties: true },
          403: cleanSchema(schemas.apiError),
          404: cleanSchema(schemas.apiError),
        },
      },
    },
    async (request, reply) => {
      const { run_id } = request.params as { run_id: string };
      if (request.workerCapability) requireWorkerOperation(request, "run.read");
      if (request.workerCapability && request.workerCapability.run_id !== run_id)
        return reply.code(403).send({
          error: {
            code: "worker_scope_rejected",
            message: "the worker capability does not authorize this run",
            request_id: request.id,
          },
        });
      const lock = await runtime.projection.runLock(run_id);
      if (lock && request.workerCapability) {
        if (sha256(canonicalJson(lock)) !== request.workerCapability.run_lock_digest)
          return reply.code(403).send({
            error: {
              code: "worker_scope_rejected",
              message: "the worker capability does not match this run lock",
              request_id: request.id,
            },
          });
        return lock;
      }
      return (
        (lock ? redactDeploymentTopology(lock) : null) ??
        reply.code(404).send({
          error: {
            code: "not_found",
            message: "run lock was not found",
            request_id: request.id,
          },
        })
      );
    },
  );

  app.post(
    "/api/v1/runs/:run_id/prepared-job",
    {
      schema: {
        tags: ["runs"],
        body: cleanSchema(schemas.preparedJobSubmission),
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["phase", "record_id", "digest", "adopted"],
            properties: {
              phase: { enum: ["trial", "finalize"] },
              record_id: { type: "string" },
              digest: { type: "string" },
              adopted: { type: "boolean" },
            },
          },
        },
      },
    },
    async (request) => {
      const { run_id } = request.params as { run_id: string };
      requireWorkerOperation(request, "preparation.submit");
      if (request.workerCapability?.run_id !== run_id)
        throw new WorkerScopeError("the worker capability does not authorize this run");
      return runtime.service.submitPreparedJob(
        run_id,
        request.workerCapability.action_id,
        request.body,
      );
    },
  );

  app.get("/api/v1/runs/:run_id/prepared-job", async (request) => {
    const { run_id } = request.params as { run_id: string };
    requireWorkerOperation(request, "run.read");
    if (request.workerCapability?.run_id !== run_id)
      throw new WorkerScopeError("the worker capability does not authorize this run");
    const prepared = await runtime.service.preparedJob(run_id);
    if (!prepared) throw new PolicyError("prepared job is not available");
    return prepared;
  });

  app.get("/api/v1/runs/:run_id/prepared-job/trials/:task_id", async (request) => {
    const { run_id, task_id } = request.params as {
      run_id: string;
      task_id: string;
    };
    requireWorkerOperation(request, "run.read");
    if (
      request.workerCapability?.run_id !== run_id ||
      !request.workerCapability.task_ids.includes(task_id)
    )
      throw new WorkerScopeError(
        "the worker capability does not authorize this prepared trial",
      );
    const prepared = await runtime.service.preparedJob(run_id);
    const trial = await runtime.service.preparedTrial(run_id, task_id);
    if (!prepared || !trial) throw new PolicyError("prepared trial is not available");
    const reference = prepared.trials.find((item) => item.task_id === task_id);
    if (
      !reference ||
      reference.record_id !== trial.record_id ||
      reference.record_digest !== sha256(canonicalJson(trial))
    )
      throw new PolicyError("prepared trial does not match the prepared job");
    return trial;
  });

  app.get(
    "/api/v1/runs/:run_id/tasks",
    {
      schema: {
        tags: ["runs"],
        response: { 200: itemList(taskSchema) },
      },
    },
    async (request) => {
      const { run_id } = request.params as { run_id: string };
      return {
        items: await runtime.projection.tasks(run_id),
        next_cursor: null,
      };
    },
  );

  app.get(
    "/api/v1/runs/:run_id/tasks/:task_id",
    {
      schema: {
        tags: ["runs"],
        response: { 200: taskDetailSchema, 404: cleanSchema(schemas.apiError) },
      },
    },
    async (request, reply) => {
      const { run_id, task_id } = request.params as {
        run_id: string;
        task_id: string;
      };
      const detail = await runtime.projection.task(run_id, task_id);
      if (!detail)
        return reply.code(404).send({
          error: {
            code: "not_found",
            message: "task was not found",
            request_id: request.id,
          },
        });
      const exhaustion = await runtime.projection.taskExhaustion(run_id, task_id);
      const jobsByLaunchAction = new Map(
        (await runtime.projection.jobs(null, 0, run_id)).map((job) => [
          job.launch_action_id,
          job,
        ]),
      );
      return {
        task: detail.task,
        attempts: detail.attempts.map((attempt) => {
          const job = jobsByLaunchAction.get(attempt.action_id);
          return {
            attempt_id: attempt.attempt_id,
            action_id: attempt.action_id,
            run_id: attempt.run_id,
            task_id: attempt.task_id,
            outcome: attempt.outcome,
            replacement_eligible: attempt.replacement_eligible,
            cost_microusd: attempt.cost_microusd,
            metrics: attempt.metrics,
            created_at: attempt.created_at,
            physical_job:
              job && (job.resource_id || job.observed_state)
                ? {
                    resource_id: job.resource_id,
                    observed_state: job.observed_state,
                    inspect_url: job.resource_id
                      ? hubJobInspectUrl(runtime.config.namespace, job.resource_id)
                      : null,
                  }
                : null,
          };
        }),
        exhaustion: exhaustion
          ? {
              source_action_id: exhaustion.source_action_id,
              last_attempt_id: exhaustion.last_attempt_id,
              attempt_count: exhaustion.attempt_count,
              reason: exhaustion.reason,
              created_at: exhaustion.created_at,
            }
          : null,
      };
    },
  );

  app.post(
    "/api/v1/runs/:run_id/actions",
    {
      schema: {
        tags: ["runs"],
        body: cleanSchema(schemas.runAction),
        response: { 202: acceptedSchema },
      },
    },
    async (request, reply) => {
      if (runtime.config.write_mode === "disabled")
        throw new ControlNotReadyError("run writes are disabled before cutover");
      const { run_id } = request.params as { run_id: string };
      const result = await runtime.service.runAction(
        run_id,
        request.body,
        idempotencyKey(request),
        domainActor(request),
      );
      return reply.code(202).send(result);
    },
  );

  app.post(
    "/api/v1/runs/:run_id/tasks/:task_id/attempts",
    {
      bodyLimit: 16 * 1024 * 1024,
      schema: {
        tags: ["runs"],
        body: {
          oneOf: [cleanSchema(schemas.attemptSubmission), evidenceUploadSchema],
        },
        response: {
          200: evidenceAcceptedSchema,
          201: evidenceAcceptedSchema,
          202: attemptAcceptedSchema,
          403: cleanSchema(schemas.apiError),
          422: cleanSchema(schemas.apiError),
        },
      },
    },
    async (request, reply) => {
      if (runtime.config.write_mode === "disabled")
        throw new ControlNotReadyError("run writes are disabled before cutover");
      const { run_id, task_id } = request.params as {
        run_id: string;
        task_id: string;
      };
      const requestKey = idempotencyKey(request);
      const input = request.body as
        | AttemptSubmissionV1
        | {
            operation: "upload_evidence";
            action_id: string;
            digest: string;
            content_base64: string;
          };
      if (!request.workerCapability)
        return reply.code(403).send({
          error: {
            code: "worker_capability_required",
            message: "worker submissions require a worker capability",
            request_id: request.id,
          },
        });
      const requiredOperation: WorkerOperation =
        "operation" in input ? "evidence.write" : "attempt.submit";
      if (
        request.workerCapability.run_id !== run_id ||
        request.workerCapability.action_id !== input.action_id ||
        !request.workerCapability.task_ids.includes(task_id) ||
        !request.workerCapability.operations.includes(requiredOperation)
      )
        return reply.code(403).send({
          error: {
            code: "worker_scope_rejected",
            message: "the worker capability does not authorize this submission",
            request_id: request.id,
          },
        });
      if ("operation" in input) {
        const bytes = Buffer.from(input.content_base64, "base64");
        if (bytes.toString("base64") !== input.content_base64)
          throw new PolicyError("evidence content must use canonical base64");
        const result = await runtime.service.uploadEvidenceObject(
          run_id,
          input.action_id,
          task_id,
          input.digest,
          bytes,
        );
        return reply.code(result.created ? 201 : 200).send(result);
      }
      const attemptId = deterministicId(
        "worker-attempt",
        run_id,
        task_id,
        sha256(requestKey),
      );
      const result = await runtime.service.attemptWithStatus(
        {
          run_id,
          task_id,
          attempt_id: attemptId,
          action_id: input.action_id,
          outcome: input.outcome,
          replacement_eligible: input.replacement_eligible,
          evidence_digest: input.evidence_digest,
          evidence_path: input.evidence_path,
          cost_microusd: input.cost_microusd,
          metrics: input.metrics,
          completed_at: input.completed_at,
        },
        domainActor(request),
      );
      return reply.code(202).send({
        run_id,
        task_id,
        attempt_id: attemptId,
        status_url: `/api/v1/runs/${run_id}/tasks/${task_id}`,
        adopted: result.adopted,
      });
    },
  );

  app.get(
    "/api/v1/jobs",
    {
      schema: {
        tags: ["resources"],
        description:
          "Lists Jobs globally with offset pagination. When run_id is present, returns every latest Job for that Run in one stable response with next_cursor set to null.",
        querystring: jobsQuerySchema,
        response: { 200: itemList(jobSchema) },
      },
    },
    async (request) => {
      const query = request.query as {
        cursor?: string;
        limit?: number;
        run_id?: string;
      };
      if (query.run_id) {
        const items = await runtime.projection.jobs(null, 0, query.run_id);
        return {
          items: items.map((item) => ({
            ...item,
            inspect_url:
              item.resource_id === null
                ? null
                : hubJobInspectUrl(runtime.config.namespace, item.resource_id),
          })),
          next_cursor: null,
        };
      }
      const limit = query.limit ?? 50;
      const offset = cursorOffset(query.cursor);
      const items = await runtime.projection.jobs(limit + 1, offset);
      return offsetPage(
        items.map((item) => ({
          ...item,
          inspect_url:
            item.resource_id === null
              ? null
              : hubJobInspectUrl(runtime.config.namespace, item.resource_id),
        })),
        offset,
        limit,
      );
    },
  );
  app.get(
    "/api/v1/endpoints",
    {
      schema: {
        tags: ["resources"],
        querystring: paginationQuerySchema,
        response: { 200: itemList(endpointSchema) },
      },
    },
    async (request) => {
      const query = request.query as { cursor?: string; limit?: number };
      const limit = query.limit ?? 50;
      const offset = cursorOffset(query.cursor);
      const items = await runtime.projection.endpoints(limit + 1, offset);
      return offsetPage(items, offset, limit);
    },
  );
  app.get(
    "/api/v1/profiles",
    {
      schema: {
        tags: ["resources"],
        querystring: paginationQuerySchema,
        response: { 200: itemList(profileSchema) },
      },
    },
    async (request) => {
      const query = request.query as { cursor?: string; limit?: number };
      const limit = query.limit ?? 50;
      const offset = cursorOffset(query.cursor);
      const items = await runtime.projection.profiles(limit + 1, offset);
      const aliases = new Map<string, string[]>();
      for (const item of runtime.service.resolver.aliases()) {
        const key = `${item.kind}:${item.profile_id}`;
        aliases.set(key, [...(aliases.get(key) ?? []), item.alias].sort());
      }
      return offsetPage(
        items.map((item) => {
          const spec = JSON.parse(item.spec_body) as Record<string, unknown>;
          if (item.profile_kind === "capacity") delete spec.namespace;
          return redactDeploymentTopology({
            ...item,
            approved_aliases:
              aliases.get(`${item.profile_kind}:${item.profile_id}`) ?? [],
            spec,
          });
        }),
        offset,
        limit,
      );
    },
  );
  app.get(
    "/api/v1/leaderboard",
    {
      schema: {
        tags: ["results"],
        description:
          "Official snapshot rows. Anonymous GET is allowed. Runs and result details stay authenticated.",
        response: { 200: leaderboardSchema },
      },
    },
    async () => {
      const loaded = await loadLatestLeaderboard(runtime.store);
      return {
        snapshot: loaded.snapshot
          ? {
              record_id: loaded.snapshot.record_id,
              created_at: loaded.snapshot.created_at,
              sqlite_digest: loaded.snapshot.sqlite_digest,
              source_digest: loaded.snapshot.source_digest,
              entry_count: loaded.snapshot.entry_count,
            }
          : null,
        items: loaded.rows,
      };
    },
  );
  app.get(
    "/api/v1/results",
    {
      schema: {
        tags: ["results"],
        querystring: resultQuerySchema,
        response: { 200: itemList(publicationSchema) },
      },
    },
    async (request) => {
      const query = request.query as ResultQuery;
      const limit = query.limit ?? 50;
      const offset = cursorOffset(query.cursor);
      const items = filterAndSortResults(await resultItems(runtime), query).slice(
        offset,
        offset + limit + 1,
      );
      return offsetPage(items, offset, limit);
    },
  );
  app.get(
    "/api/v1/results/:publication_id",
    {
      schema: {
        tags: ["results"],
        params: {
          type: "object",
          required: ["publication_id"],
          properties: { publication_id: { type: "string", maxLength: 160 } },
        },
        response: { 200: publicationSchema, 404: cleanSchema(schemas.apiError) },
      },
    },
    async (request, reply) => {
      const { publication_id } = request.params as { publication_id: string };
      const item = (await resultItems(runtime)).find(
        (candidate) => candidate.publication_id === publication_id,
      );
      return (
        item ??
        reply.code(404).send({
          error: {
            code: "not_found",
            message: "result was not found",
            request_id: request.id,
          },
        })
      );
    },
  );
  app.get(
    "/api/v1/audit",
    {
      schema: {
        tags: ["audit"],
        querystring: {
          type: "object",
          properties: {
            cursor: { type: "string", maxLength: 1024 },
            limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
          },
        },
        response: { 200: auditSchema },
      },
    },
    async (request) => {
      const query = request.query as { cursor?: string; limit?: number };
      const limit = query.limit ?? 100;
      const items = await runtime.projection.audit(query.cursor ?? null, limit + 1);
      const page = items.slice(0, limit);
      return {
        items: page,
        next_cursor: items.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
    },
  );

  app.get(
    "/api/v1/events",
    {
      schema: {
        tags: ["audit"],
        description:
          "Streams bounded durable-event replay and live updates. cursor.reset tells clients to refetch current state and resume from data.latest_cursor.",
        produces: ["text/event-stream"],
        querystring: {
          type: "object",
          properties: {
            cursor: {
              type: "string",
              maxLength: 1024,
              description:
                "Last durable cursor received. Replay is capped; stale cursors receive cursor.reset.",
            },
          },
        },
        response: {
          200: {
            type: "string",
            description:
              "Server-Sent Events frames. Durable envelopes have an id. cursor.reset has no id and includes reason, latest_cursor, and replay_limit metadata.",
          },
        },
      },
    },
    async (request, reply) => {
      const query = request.query as { cursor?: string };
      const cursor =
        (request.headers["last-event-id"] as string | undefined) ??
        query.cursor ??
        null;
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.flushHeaders();
      const seen = new Set<string>();
      const buffered: ControlEvent[] = [];
      let replaying = true;
      let bufferLimitExceeded = false;
      let stopped = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: () => void = () => undefined;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        replaying = false;
        buffered.length = 0;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        unsubscribe();
      };
      const closeCleanly = () => {
        stop();
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      };
      request.raw.once("close", stop);
      request.raw.once("error", stop);
      reply.raw.once("close", stop);
      reply.raw.once("error", stop);
      unsubscribe = runtime.service.events.subscribe((event) => {
        if (stopped) return;
        if (replaying) {
          if (buffered.length >= SSE_LIVE_BUFFER_LIMIT) {
            bufferLimitExceeded = true;
            return;
          }
          buffered.push(event);
          return;
        }
        if (
          !sendSseEnvelope(reply, {
            ...event,
            replay: false,
            cursor_reset: false,
          })
        )
          closeCleanly();
      });
      if (stopped) unsubscribe();
      const sendDuringReplay = async (event: SseEnvelope): Promise<boolean> => {
        if (sendSseEnvelope(reply, event)) return true;
        if (await waitForSseDrain(reply)) return true;
        stop();
        return false;
      };
      const resetCursor = async (reason: CursorResetReason): Promise<boolean> => {
        // The reset cursor covers everything already projected. Events emitted
        // after this snapshot remain in the bounded live buffer below.
        buffered.length = 0;
        seen.clear();
        bufferLimitExceeded = false;
        return sendDuringReplay(
          cursorResetEnvelope(reason, runtime.projection.system().event_cursor),
        );
      };
      const flushBuffered = async (): Promise<boolean> => {
        while (!bufferLimitExceeded && buffered.length > 0) {
          const event = buffered.shift();
          if (
            event &&
            !seen.has(event.id) &&
            !(await sendDuringReplay({
              ...event,
              replay: false,
              cursor_reset: false,
            }))
          )
            return false;
        }
        return !bufferLimitExceeded;
      };
      try {
        let resetReason: CursorResetReason | null = null;
        if (cursor) {
          try {
            if (!runtime.projection.eventCursorIsCurrent(cursor))
              resetReason = "epoch_changed";
          } catch {
            resetReason = "invalid_cursor";
          }
        }
        let replay: ControlEvent[] = [];
        if (cursor && !resetReason) {
          replay = await runtime.projection.audit(cursor, SSE_REPLAY_LIMIT + 1);
          if (stopped) return;
          if (replay.length > SSE_REPLAY_LIMIT) resetReason = "replay_limit_exceeded";
        }
        if (bufferLimitExceeded) resetReason = "buffer_limit_exceeded";
        if (resetReason) {
          if (!(await resetCursor(resetReason))) return;
          if (!(await flushBuffered())) {
            // The client received the reset before this clean close. Its
            // reconnect resumes durable replay from that reset cursor.
            closeCleanly();
            return;
          }
        } else {
          for (const event of replay) {
            if (bufferLimitExceeded) break;
            seen.add(event.id);
            if (
              !(await sendDuringReplay({
                ...event,
                replay: true,
                cursor_reset: false,
              }))
            )
              return;
          }
          if (!(await flushBuffered())) {
            if (!(await resetCursor("buffer_limit_exceeded"))) return;
            if (!(await flushBuffered())) {
              // Do not retain or silently skip an event beyond the live bound.
              closeCleanly();
              return;
            }
          }
        }
        replaying = false;
        buffered.length = 0;
        seen.clear();
        heartbeat = setInterval(() => {
          if (
            !sendSseEnvelope(reply, {
              type: "heartbeat",
              occurred_at: new Date().toISOString(),
              data: {},
              replay: false,
              cursor_reset: false,
            })
          ) {
            closeCleanly();
          }
        }, 15_000);
      } catch (error) {
        stop();
        if (!reply.raw.destroyed)
          reply.raw.destroy(error instanceof Error ? error : undefined);
      }
    },
  );

  app.setErrorHandler(async (error, request, reply) => {
    let status = 500;
    let code = "internal_error";
    let message = "the request could not be completed";
    if (error instanceof ConfirmationRequiredError) {
      status = 400;
      code = "confirmation_required";
      message = error.message;
    } else if (error instanceof IdempotencyConflictError) {
      status = 409;
      code = "idempotency_conflict";
      message = error.message;
    } else if (error instanceof ControlNotReadyError) {
      status = 503;
      code = "control_not_ready";
      message = error.message;
    } else if (error instanceof ProfileResolutionError) {
      status = 422;
      code = "profile_resolution_failed";
      message = error.message;
    } else if (error instanceof WorkerScopeError) {
      status = 403;
      code = "worker_scope_rejected";
      message = error.message;
    } else if (error instanceof PolicyError) {
      status = 422;
      code = "policy_rejected";
      message = error.message;
    } else if (error instanceof UnauthorizedSubjectError) {
      status = 403;
      code = "access_denied";
      message = "this identity is not authorized";
    } else if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 413
    ) {
      status = 413;
      code = "request_too_large";
      message = "request body exceeds the route limit";
    } else if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 429
    ) {
      status = 429;
      code = "rate_limit_exceeded";
      message = "request rate limit exceeded";
    } else if (
      typeof error === "object" &&
      error !== null &&
      "validation" in error &&
      error.validation
    ) {
      status = 400;
      code = "invalid_request";
      message = "request validation failed";
    }
    request.log.error(
      { err: { name: error instanceof Error ? error.name : "Error", message: code } },
      "request failed",
    );
    await reply.code(status).send({ error: { code, message, request_id: request.id } });
  });

  if (existsSync(runtime.config.web_root)) {
    await app.register(fastifyStatic, {
      root: runtime.config.web_root,
      prefix: "/",
      wildcard: false,
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (
        request.url.startsWith("/api/") ||
        request.url.startsWith("/health/") ||
        request.url.startsWith("/auth/")
      )
        return reply.code(404).send({
          error: {
            code: "not_found",
            message: "route was not found",
            request_id: request.id,
          },
        });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
