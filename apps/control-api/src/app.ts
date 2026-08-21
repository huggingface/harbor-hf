import { existsSync } from "node:fs";
import { posix } from "node:path";
import type {
  ActionIntent,
  ActionReceipt,
  Actor,
  AttemptSubmissionV1,
  CampaignSubmissionV1,
  HarborHFResultCatalogV1,
  SandboxPolicy,
} from "@harbor-hf/contracts";
import {
  canonicalJson,
  deterministicId,
  sandboxActionResultPath,
  schemas,
  sha256,
  validateResultCatalog,
} from "@harbor-hf/contracts";
import {
  ConfirmationRequiredError,
  ControlNotReadyError,
  createJson,
  IdempotencyConflictError,
  PolicyError,
  ProfileResolutionError,
  SandboxActionAmbiguousError,
  type ActionDispositionCorrectionInput,
  type ControlEvent,
  type WorkerCapability,
  type WorkerOperation,
  preparedSandboxPolicy,
  preparationRequired,
  staticSandboxPolicy,
  summarizePublishedResult,
  verifyWorkerCapability,
} from "@harbor-hf/control-core";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  acceptedSchema,
  actionDispositionCorrectionResultSchema,
  actionDispositionCorrectionSchema,
  actionDispositionViewSchema,
  attemptAcceptedSchema,
  auditSchema,
  campaignListSchema,
  campaignViewSchema,
  capacitySchema,
  endpointSchema,
  evidenceAcceptedSchema,
  evidenceUploadSchema,
  itemList,
  jobSchema,
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
      (/^\/api\/v1\/campaigns\/[^/]+$/.test(path) ||
        /^\/api\/v1\/campaigns\/[^/]+\/(?:lock|prepared-job(?:\/trials\/[^/]+)?)$/.test(
          path,
        ))) ||
    (request.method === "POST" &&
      /^\/api\/v1\/campaigns\/[^/]+\/(?:prepared-job|tasks\/[^/]+\/attempts)$/.test(
        path,
      )) ||
    (/^[A-Z]+$/.test(request.method) &&
      /^\/api\/v1\/campaigns\/[^/]+\/tasks\/[^/]+\/sandboxes(?:\/[^/]+(?:\/observe|\/exec|\/files(?:\/read)?)?)?$/.test(
        path,
      ))
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
  if (path.startsWith("/api/")) return ["anonymous:api", 240];
  return ["anonymous:static", 600];
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

function requireAllowedSandboxPath(path: string, policy: SandboxPolicy): string {
  if (!posix.isAbsolute(path) || posix.normalize(path) !== path)
    throw new PolicyError("sandbox path must be normalized and absolute");
  if (
    !policy.allowed_roots.some(
      (root) => path === root || path.startsWith(`${root.replace(/\/$/, "")}/`),
    )
  )
    throw new PolicyError("sandbox path is outside immutable policy roots");
  return path;
}

function redactSandboxTopology<T>(value: T): T {
  const clone = structuredClone(value) as T;
  if (!clone || typeof clone !== "object") return clone;
  const profiles = (clone as { profiles?: unknown }).profiles;
  const candidates = Array.isArray(profiles) ? profiles : [clone];
  for (const profile of candidates) {
    if (!profile || typeof profile !== "object") continue;
    const spec = (profile as { spec?: unknown }).spec;
    if (!spec || typeof spec !== "object") continue;
    const record = spec as {
      sandbox?: unknown;
      sandbox_template?: unknown;
    };
    for (const sandbox of [record.sandbox, record.sandbox_template]) {
      if (!sandbox || typeof sandbox !== "object") continue;
      if ("inference_upstream" in sandbox)
        (sandbox as { inference_upstream?: string }).inference_upstream = "<redacted>";
    }
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
  properties: {
    ...paginationQuerySchema.properties,
    campaign_id: { type: "string", minLength: 1, maxLength: 160 },
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

function sendEvent(reply: FastifyReply, event: ControlEvent): void {
  reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
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

async function resultItems(runtime: Runtime): Promise<Record<string, unknown>[]> {
  const publications = await runtime.projection.publications();
  const byId = new Map<string, Record<string, unknown>>(
    publications.map((publication) => [
      publication.publication_id,
      {
        publication_id: publication.publication_id,
        campaign_id: publication.campaign_id,
        status: publication.status,
        catalog_digest: publication.catalog_digest,
        published_at: publication.created_at,
      },
    ]),
  );
  const catalogs = await runtime.store.list("results/schema=v1/catalog");
  for (const object of catalogs) {
    if (!object.key.endsWith(".json")) continue;
    const parsed = JSON.parse(
      new TextDecoder().decode(await runtime.store.read(object.key)),
    );
    const catalog = validateResultCatalog<HarborHFResultCatalogV1>(parsed);
    for (const entry of catalog.entries) {
      byId.set(entry.publication_id, {
        ...entry,
        status: "published",
        catalog_digest: object.digest,
        catalog_source_digest: catalog.source_digest,
      });
    }
  }
  for (const item of byId.values()) {
    const campaignId = typeof item.campaign_id === "string" ? item.campaign_id : null;
    if (!campaignId) continue;
    const lock = await runtime.projection.campaignLock(campaignId);
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
    const campaignId = typeof item.campaign_id === "string" ? item.campaign_id : null;
    const publicationId =
      typeof item.publication_id === "string" ? item.publication_id : null;
    if (!publicationId) continue;
    const campaign = campaignId ? await runtime.projection.campaign(campaignId) : null;
    const projectedTasks = campaignId ? await runtime.projection.tasks(campaignId) : [];
    const projectedAttempts = campaignId
      ? await runtime.projection.campaignAttempts(campaignId)
      : [];
    const summary = summarizePublishedResult({
      bucketId: runtime.config.bucket_id,
      publicationId,
      resultPath: typeof item.result_path === "string" ? item.result_path : null,
      catalogTaskCount: typeof item.task_count === "number" ? item.task_count : null,
      catalogStrictPassCount:
        typeof item.strict_pass_count === "number" ? item.strict_pass_count : null,
      observedCostMicrousd: campaign?.observed_microusd ?? null,
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
        item.campaign_id,
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
  const input = body as Partial<CampaignSubmissionV1>;
  return (
    input.benchmark === "control-smoke" &&
    input.model === "control-smoke" &&
    input.harness === "control-smoke" &&
    input.launch_policy === "control-smoke" &&
    (input.deployment === undefined ||
      input.deployment === null ||
      input.deployment === "hf-cpu-smoke" ||
      input.deployment === "hf-cpu-sandbox-smoke")
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
      tags: ["system", "campaigns", "resources", "results", "audit", "auth"].map(
        (name) => ({ name }),
      ),
    },
  });

  const loadSandboxContext = async (
    request: FastifyRequest,
    campaignId: string,
    taskId: string,
    operation: WorkerOperation,
    sandboxId?: string,
  ) => {
    const capability = requireWorkerOperation(request, operation);
    if (capability.campaign_id !== campaignId || !capability.task_ids.includes(taskId))
      throw new WorkerScopeError("worker capability does not authorize this task");
    const lock = await runtime.projection.campaignLock(campaignId);
    if (!lock) throw new PolicyError("campaign lock is missing");
    if (sha256(canonicalJson(lock)) !== capability.campaign_lock_digest)
      throw new WorkerScopeError("worker capability does not match the campaign lock");
    const deployment = lock.profiles.find((profile) => profile.kind === "deployment");
    let policy: SandboxPolicy | null;
    try {
      if (!deployment) policy = null;
      else if (preparationRequired(deployment.spec)) {
        const prepared = await runtime.service.preparedJob(campaignId);
        const trial = await runtime.service.preparedTrial(campaignId, taskId);
        if (!prepared || !trial)
          throw new PolicyError("campaign preparation is incomplete");
        const reference = prepared.trials.find((item) => item.task_id === taskId);
        if (
          !reference ||
          reference.record_id !== trial.record_id ||
          reference.record_digest !== sha256(canonicalJson(trial))
        )
          throw new PolicyError("prepared trial does not match the prepared job");
        policy = preparedSandboxPolicy(deployment.spec, trial);
      } else policy = staticSandboxPolicy(deployment.spec);
    } catch (error) {
      throw new PolicyError(
        error instanceof Error ? error.message : "prepared Sandbox policy is invalid",
      );
    }
    if (!policy) throw new PolicyError("campaign does not authorize Sandboxes");
    if (!lock.tasks.some((task) => task.task_id === taskId))
      throw new PolicyError("campaign lock does not contain this task");
    let resourceId: string | null = null;
    if (sandboxId) {
      const row = await runtime.projection.action(sandboxId);
      if (
        !row ||
        row.campaign_id !== campaignId ||
        row.action_kind !== "sandbox.create"
      )
        throw new PolicyError("sandbox identifier is invalid");
      const createIntent = JSON.parse(row.intent_body) as ActionIntent;
      if (createIntent.payload.task_id !== taskId)
        throw new PolicyError("sandbox identifier does not belong to this task");
      resourceId = row.resource_id;
      if (!resourceId) throw new PolicyError("sandbox creation is not complete");
    }
    return { capability, lock, policy, resourceId };
  };

  const executeSandboxAction = async <T>(
    request: FastifyRequest,
    campaignId: string,
    _taskId: string,
    actionKind: ActionIntent["action_kind"],
    target: string,
    payload: ActionIntent["payload"],
    replaySafe: boolean,
    execute: (
      intent: ActionIntent,
      adoptionOnly: boolean,
    ) => Promise<{
      external: {
        outcome: ActionReceipt["outcome"];
        observed_state: string;
        resource_id?: string | null;
        cost_microusd?: number | null;
      };
      result: T;
    }>,
    ownsDispatch = false,
  ): Promise<T> => {
    const keyDigest = sha256(idempotencyKey(request));
    const intent = runtime.service.actionIntent(
      campaignId,
      actionKind,
      `${target}:${keyDigest.slice(7, 23)}`,
      0,
      payload,
      domainActor(request),
    );
    return runtime.service.withSandboxActionFinalization(intent.action_id, async () => {
      const existing = await runtime.projection.action(intent.action_id);
      const resultPath = sandboxActionResultPath(campaignId, intent.action_id);
      const resultPrefix = resultPath.slice(0, -"/result.json".length);
      const resultEntry = (await runtime.store.list(resultPrefix)).find(
        (entry) => entry.key === resultPath,
      );
      if (resultEntry) {
        await runtime.service.writeAction(intent);
        const bytes = await runtime.store.read(resultPath);
        const stored = JSON.parse(new TextDecoder().decode(bytes)) as {
          external: {
            outcome: ActionReceipt["outcome"];
            observed_state: string;
            resource_id?: string | null;
            cost_microusd?: number | null;
          };
          result: T;
        };
        if (!existing?.receipt_body) {
          const receipt = await runtime.service.receipt(intent, stored.external);
          await runtime.service.markAdvanced(intent, receipt);
        }
        return stored.result;
      }
      if (existing?.receipt_body) {
        const receipt = JSON.parse(existing.receipt_body) as ActionReceipt;
        if (
          receipt.outcome === "failed" &&
          receipt.observed_state === "AMBIGUOUS" &&
          receipt.error_code === "sandbox_external_outcome_unknown"
        )
          throw new IdempotencyConflictError(
            "ambiguous Sandbox action cannot be replayed",
          );
        throw new PolicyError("Sandbox action receipt is missing its durable result");
      }
      const dispatched = await runtime.projection.actionDispatch(intent.action_id);
      await runtime.service.writeAction(intent);
      if (dispatched && !replaySafe)
        throw new IdempotencyConflictError(
          "ambiguous sandbox command cannot be replayed; inspect state and use a new key",
        );
      await runtime.service.dispatchAction(
        intent,
        new Date(Date.now() + 30_000).toISOString(),
      );
      let output: Awaited<ReturnType<typeof execute>>;
      try {
        output = await execute(intent, Boolean(dispatched) && !ownsDispatch);
      } catch (error) {
        if (!replaySafe) {
          const receipt = await runtime.service.ambiguousSandboxReceipt(
            intent,
            domainActor(request),
          );
          await runtime.service.markAdvanced(intent, receipt);
          throw new SandboxActionAmbiguousError(
            "Sandbox action outcome is unknown and cannot be replayed",
          );
        }
        throw error;
      }
      await createJson(runtime.store, resultPath, output);
      const receipt = await runtime.service.receipt(intent, output.external);
      await runtime.service.markAdvanced(intent, receipt);
      return output.result;
    });
  };

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
        username: "Campaign worker",
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
      schema: { tags: ["system"] },
    },
    async (_request, reply) => {
      const state = runtime.projection.system();
      const dependencies = {
        projection: state.ready,
        object_store:
          runtime.config.store_mode === "bucket"
            ? Boolean(runtime.config.hf_token)
            : existsSync(runtime.config.bucket_root),
        hf_token:
          runtime.config.write_mode === "disabled" || Boolean(runtime.config.hf_token),
      };
      const ready = Object.values(dependencies).every(Boolean);
      return reply
        .code(ready ? 200 : 503)
        .send({ status: ready ? "ready" : "rebuilding" });
    },
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
      projection: runtime.projection.system(),
      resource_contract: { spaces: 1, buckets: 1, operator_secrets: 2 },
    }),
  );

  app.get(
    "/api/v1/campaigns",
    {
      schema: {
        tags: ["campaigns"],
        querystring: paginationQuerySchema,
        response: { 200: campaignListSchema },
      },
    },
    async (request) => {
      const query = request.query as { cursor?: string; limit?: number };
      const limit = query.limit ?? 50;
      const offset = cursorOffset(query.cursor);
      const items = await runtime.projection.campaigns(limit + 1, offset);
      return offsetPage(items, offset, limit);
    },
  );

  app.post(
    "/api/v1/campaigns",
    {
      schema: {
        tags: ["campaigns"],
        body: cleanSchema(schemas.campaignSubmission),
        response: { 202: acceptedSchema },
      },
    },
    async (request, reply) => {
      if (runtime.config.write_mode === "disabled")
        throw new ControlNotReadyError("campaign writes are disabled before cutover");
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
    "/api/v1/campaigns/:campaign_id",
    {
      schema: {
        tags: ["campaigns"],
        params: {
          type: "object",
          required: ["campaign_id"],
          properties: { campaign_id: { type: "string" } },
        },
        response: { 200: campaignViewSchema, 404: cleanSchema(schemas.apiError) },
      },
    },
    async (request, reply) => {
      const { campaign_id } = request.params as { campaign_id: string };
      if (request.workerCapability) {
        requireWorkerOperation(request, "campaign.read");
        if (request.workerCapability.campaign_id !== campaign_id)
          throw new WorkerScopeError(
            "the worker capability does not authorize this campaign",
          );
      }
      const campaign = await runtime.projection.campaign(campaign_id);
      return (
        campaign ??
        reply.code(404).send({
          error: {
            code: "not_found",
            message: "campaign was not found",
            request_id: request.id,
          },
        })
      );
    },
  );

  app.get(
    "/api/v1/campaigns/:campaign_id/capacity",
    {
      schema: {
        tags: ["campaigns"],
        response: { 200: capacitySchema, 404: cleanSchema(schemas.apiError) },
      },
    },
    async (request, reply) => {
      const { campaign_id } = request.params as { campaign_id: string };
      if (!(await runtime.projection.campaign(campaign_id)))
        return reply.code(404).send({
          error: {
            code: "not_found",
            message: "campaign was not found",
            request_id: request.id,
          },
        });
      return runtime.service.sandboxCapacityView(campaign_id);
    },
  );

  app.get(
    "/api/v1/campaigns/:campaign_id/lock",
    {
      schema: {
        tags: ["campaigns"],
        response: {
          200: { type: "object", additionalProperties: true },
          403: cleanSchema(schemas.apiError),
          404: cleanSchema(schemas.apiError),
        },
      },
    },
    async (request, reply) => {
      const { campaign_id } = request.params as { campaign_id: string };
      if (request.workerCapability) requireWorkerOperation(request, "campaign.read");
      if (
        request.workerCapability &&
        request.workerCapability.campaign_id !== campaign_id
      )
        return reply.code(403).send({
          error: {
            code: "worker_scope_rejected",
            message: "the worker capability does not authorize this campaign",
            request_id: request.id,
          },
        });
      const lock = await runtime.projection.campaignLock(campaign_id);
      if (lock && request.workerCapability) {
        if (
          sha256(canonicalJson(lock)) !== request.workerCapability.campaign_lock_digest
        )
          return reply.code(403).send({
            error: {
              code: "worker_scope_rejected",
              message: "the worker capability does not match this campaign lock",
              request_id: request.id,
            },
          });
        return {
          ...lock,
          tasks: lock.tasks.filter((task) =>
            request.workerCapability?.task_ids.includes(task.task_id),
          ),
        };
      }
      return (
        (lock ? redactSandboxTopology(lock) : null) ??
        reply.code(404).send({
          error: {
            code: "not_found",
            message: "campaign lock was not found",
            request_id: request.id,
          },
        })
      );
    },
  );

  app.post(
    "/api/v1/campaigns/:campaign_id/prepared-job",
    {
      schema: {
        tags: ["campaigns"],
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
      const { campaign_id } = request.params as { campaign_id: string };
      requireWorkerOperation(request, "preparation.submit");
      if (request.workerCapability?.campaign_id !== campaign_id)
        throw new WorkerScopeError(
          "the worker capability does not authorize this campaign",
        );
      return runtime.service.submitPreparedJob(
        campaign_id,
        request.workerCapability.action_id,
        request.body,
      );
    },
  );

  app.get("/api/v1/campaigns/:campaign_id/prepared-job", async (request) => {
    const { campaign_id } = request.params as { campaign_id: string };
    requireWorkerOperation(request, "campaign.read");
    if (request.workerCapability?.campaign_id !== campaign_id)
      throw new WorkerScopeError(
        "the worker capability does not authorize this campaign",
      );
    const prepared = await runtime.service.preparedJob(campaign_id);
    if (!prepared) throw new PolicyError("prepared job is not available");
    return prepared;
  });

  app.get(
    "/api/v1/campaigns/:campaign_id/prepared-job/trials/:task_id",
    async (request) => {
      const { campaign_id, task_id } = request.params as {
        campaign_id: string;
        task_id: string;
      };
      requireWorkerOperation(request, "campaign.read");
      if (
        request.workerCapability?.campaign_id !== campaign_id ||
        !request.workerCapability.task_ids.includes(task_id)
      )
        throw new WorkerScopeError(
          "the worker capability does not authorize this prepared trial",
        );
      const prepared = await runtime.service.preparedJob(campaign_id);
      const trial = await runtime.service.preparedTrial(campaign_id, task_id);
      if (!prepared || !trial) throw new PolicyError("prepared trial is not available");
      const reference = prepared.trials.find((item) => item.task_id === task_id);
      if (
        !reference ||
        reference.record_id !== trial.record_id ||
        reference.record_digest !== sha256(canonicalJson(trial))
      )
        throw new PolicyError("prepared trial does not match the prepared job");
      return trial;
    },
  );

  app.post(
    "/api/v1/campaigns/:campaign_id/tasks/:task_id/sandboxes",
    {
      schema: {
        tags: ["campaigns"],
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["sandbox_id", "state"],
            properties: { sandbox_id: { type: "string" }, state: { type: "string" } },
          },
          202: {
            type: "object",
            additionalProperties: false,
            required: ["sandbox_id", "state", "limiting_factor", "not_before"],
            properties: {
              sandbox_id: { type: "string" },
              state: { const: "QUEUED" },
              limiting_factor: {
                anyOf: [{ type: "string" }, { type: "null" }],
              },
              not_before: {
                anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { campaign_id, task_id } = request.params as {
        campaign_id: string;
        task_id: string;
      };
      const context = await loadSandboxContext(
        request,
        campaign_id,
        task_id,
        "sandbox.create",
      );
      const target = `sandbox:${task_id}`;
      const payload = { task_id, sandbox: context.policy };
      const candidate = runtime.service.actionIntent(
        campaign_id,
        "sandbox.create",
        `${target}:${sha256(idempotencyKey(request)).slice(7, 23)}`,
        0,
        payload,
        domainActor(request),
      );
      const admission = await runtime.service.admitSandboxCreate(
        candidate,
        context.policy.max_sandboxes,
      );
      if (admission.status === "rejected")
        throw new PolicyError(
          `Sandbox admission rejected: ${admission.limiting_factor ?? "policy"}`,
        );
      if (!runtime.service.capacityProfile()) {
        if (!runtime.sandboxes) throw new PolicyError("Sandbox gateway is unavailable");
        return executeSandboxAction(
          request,
          campaign_id,
          task_id,
          "sandbox.create",
          target,
          payload,
          true,
          async (intent, adoptionOnly) => {
            const external = await runtime.sandboxes?.lifecycle(intent, {
              adoption_only: adoptionOnly,
            });
            if (!external) throw new PolicyError("Sandbox gateway is unavailable");
            return {
              external,
              result: {
                sandbox_id: intent.action_id,
                state: external.observed_state,
              },
            };
          },
          admission.dispatch_created,
        );
      }
      const row = await runtime.projection.action(candidate.action_id);
      if (row?.receipt_body) {
        const receipt = JSON.parse(row.receipt_body) as ActionReceipt;
        if (receipt.outcome === "failed")
          throw new PolicyError(
            `Sandbox creation failed: ${receipt.error_code ?? receipt.observed_state}`,
          );
        return {
          sandbox_id: candidate.action_id,
          state: receipt.observed_state,
        };
      }
      return reply.code(202).send({
        sandbox_id: candidate.action_id,
        state: "QUEUED",
        limiting_factor: admission.limiting_factor,
        not_before: admission.not_before,
      });
    },
  );

  app.post(
    "/api/v1/campaigns/:campaign_id/tasks/:task_id/sandboxes/:sandbox_id/observe",
    async (request) => {
      const { campaign_id, task_id, sandbox_id } = request.params as {
        campaign_id: string;
        task_id: string;
        sandbox_id: string;
      };
      const context = await loadSandboxContext(
        request,
        campaign_id,
        task_id,
        "sandbox.observe",
        sandbox_id,
      );
      if (!runtime.sandboxes || !context.resourceId)
        throw new PolicyError("Sandbox gateway is unavailable");
      return executeSandboxAction(
        request,
        campaign_id,
        task_id,
        "sandbox.observe",
        `sandbox-observe:${sandbox_id}`,
        {
          task_id,
          sandbox_create_action_id: sandbox_id,
          resource_id: context.resourceId,
          sandbox: context.policy,
        },
        true,
        async (intent) => {
          const external = await runtime.sandboxes?.lifecycle(intent);
          if (!external) throw new PolicyError("Sandbox gateway is unavailable");
          return {
            external,
            result: { sandbox_id, state: external.observed_state },
          };
        },
      );
    },
  );

  app.post(
    "/api/v1/campaigns/:campaign_id/tasks/:task_id/sandboxes/:sandbox_id/exec",
    {
      bodyLimit: 1024 * 1024,
      schema: {
        tags: ["campaigns"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["command", "cwd", "timeout_seconds"],
          properties: {
            command: {
              type: "array",
              minItems: 1,
              maxItems: 128,
              items: { type: "string", maxLength: 4096 },
            },
            cwd: { type: "string", minLength: 1, maxLength: 512 },
            timeout_seconds: { type: "integer", minimum: 1, maximum: 86400 },
          },
        },
      },
    },
    async (request) => {
      const { campaign_id, task_id, sandbox_id } = request.params as {
        campaign_id: string;
        task_id: string;
        sandbox_id: string;
      };
      const body = request.body as {
        command: [string, ...string[]];
        cwd: string;
        timeout_seconds: number;
      };
      const context = await loadSandboxContext(
        request,
        campaign_id,
        task_id,
        "sandbox.exec",
        sandbox_id,
      );
      if (!runtime.sandboxes || !context.resourceId)
        throw new PolicyError("Sandbox gateway is unavailable");
      requireAllowedSandboxPath(body.cwd, context.policy);
      if (body.timeout_seconds > context.policy.max_command_seconds)
        throw new PolicyError("Sandbox command timeout exceeds immutable policy");
      const target = `sandbox-exec:${sandbox_id}`;
      const payload = {
        task_id,
        sandbox_create_action_id: sandbox_id,
        resource_id: context.resourceId,
        sandbox: context.policy,
        command: body.command,
        cwd: body.cwd,
        timeout_seconds: body.timeout_seconds,
      };
      const candidate = runtime.service.actionIntent(
        campaign_id,
        "sandbox.exec",
        `${target}:${sha256(idempotencyKey(request)).slice(7, 23)}`,
        0,
        payload,
        domainActor(request),
      );
      await runtime.service.admitSandboxCommand(candidate, context.policy.max_commands);
      return executeSandboxAction(
        request,
        campaign_id,
        task_id,
        "sandbox.exec",
        target,
        payload,
        false,
        async (intent) => ({
          external: {
            outcome: "completed",
            observed_state: "command-completed",
            resource_id: context.resourceId,
          },
          result: await runtime.sandboxes?.execute(intent),
        }),
      );
    },
  );

  app.put(
    "/api/v1/campaigns/:campaign_id/tasks/:task_id/sandboxes/:sandbox_id/files",
    {
      bodyLimit: 90 * 1024 * 1024,
      schema: {
        tags: ["campaigns"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["path", "content_digest", "content_base64"],
          properties: {
            path: { type: "string", minLength: 1, maxLength: 512 },
            content_digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
            content_base64: { type: "string", maxLength: 89478488 },
            mode: { type: "string", pattern: "^0[0-7]{3}$" },
          },
        },
      },
    },
    async (request) => {
      const { campaign_id, task_id, sandbox_id } = request.params as {
        campaign_id: string;
        task_id: string;
        sandbox_id: string;
      };
      const body = request.body as {
        path: string;
        content_digest: string;
        content_base64: string;
        mode?: string;
      };
      const context = await loadSandboxContext(
        request,
        campaign_id,
        task_id,
        "sandbox.write",
        sandbox_id,
      );
      if (!runtime.sandboxes || !context.resourceId)
        throw new PolicyError("Sandbox gateway is unavailable");
      const path = requireAllowedSandboxPath(body.path, context.policy);
      const bytes = Buffer.from(body.content_base64, "base64");
      if (bytes.toString("base64") !== body.content_base64)
        throw new PolicyError("Sandbox write content must use canonical base64");
      if (bytes.byteLength > context.policy.max_transfer_bytes)
        throw new PolicyError("Sandbox write exceeds immutable transfer limit");
      if (sha256(bytes) !== body.content_digest)
        throw new PolicyError("Sandbox write digest does not match content");
      return executeSandboxAction(
        request,
        campaign_id,
        task_id,
        "sandbox.write",
        `sandbox-write:${sandbox_id}:${sha256(path)}`,
        {
          task_id,
          sandbox_create_action_id: sandbox_id,
          resource_id: context.resourceId,
          sandbox: context.policy,
          path,
          content_digest: body.content_digest,
          content_size: bytes.byteLength,
          ...(body.mode ? { mode: body.mode } : {}),
        },
        true,
        async (intent) => {
          await runtime.sandboxes?.write(intent, bytes);
          return {
            external: {
              outcome: "completed",
              observed_state: "write-completed",
              resource_id: context.resourceId,
            },
            result: { digest: body.content_digest, size: bytes.byteLength },
          };
        },
      );
    },
  );

  app.post(
    "/api/v1/campaigns/:campaign_id/tasks/:task_id/sandboxes/:sandbox_id/files/read",
    {
      schema: {
        tags: ["campaigns"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: { path: { type: "string", minLength: 1, maxLength: 512 } },
        },
      },
    },
    async (request) => {
      const { campaign_id, task_id, sandbox_id } = request.params as {
        campaign_id: string;
        task_id: string;
        sandbox_id: string;
      };
      const body = request.body as { path: string };
      const context = await loadSandboxContext(
        request,
        campaign_id,
        task_id,
        "sandbox.read",
        sandbox_id,
      );
      if (!runtime.sandboxes || !context.resourceId)
        throw new PolicyError("Sandbox gateway is unavailable");
      const path = requireAllowedSandboxPath(body.path, context.policy);
      return executeSandboxAction(
        request,
        campaign_id,
        task_id,
        "sandbox.read",
        `sandbox-read:${sandbox_id}:${sha256(path)}`,
        {
          task_id,
          sandbox_create_action_id: sandbox_id,
          resource_id: context.resourceId,
          sandbox: context.policy,
          path,
        },
        true,
        async (intent) => {
          const output = await runtime.sandboxes?.read(intent);
          if (!output) throw new PolicyError("Sandbox gateway is unavailable");
          const digest = sha256(output.bytes);
          return {
            external: {
              outcome: "completed",
              observed_state: "read-completed",
              resource_id: context.resourceId,
            },
            result: {
              digest,
              size: output.bytes.byteLength,
              content_base64: Buffer.from(output.bytes).toString("base64"),
            },
          };
        },
      );
    },
  );

  app.delete(
    "/api/v1/campaigns/:campaign_id/tasks/:task_id/sandboxes/:sandbox_id",
    async (request) => {
      const { campaign_id, task_id, sandbox_id } = request.params as {
        campaign_id: string;
        task_id: string;
        sandbox_id: string;
      };
      const context = await loadSandboxContext(
        request,
        campaign_id,
        task_id,
        "sandbox.close",
        sandbox_id,
      );
      if (!runtime.sandboxes || !context.resourceId)
        throw new PolicyError("Sandbox gateway is unavailable");
      return executeSandboxAction(
        request,
        campaign_id,
        task_id,
        "sandbox.close",
        `sandbox-close:${sandbox_id}`,
        {
          task_id,
          sandbox_create_action_id: sandbox_id,
          resource_id: context.resourceId,
          sandbox: context.policy,
        },
        true,
        async (intent) => {
          const external = await runtime.sandboxes?.lifecycle(intent);
          if (!external) throw new PolicyError("Sandbox gateway is unavailable");
          return {
            external,
            result: { sandbox_id, state: external.observed_state },
          };
        },
      );
    },
  );

  app.get(
    "/api/v1/campaigns/:campaign_id/tasks",
    {
      schema: {
        tags: ["campaigns"],
        querystring: paginationQuerySchema,
        response: { 200: itemList(taskSchema) },
      },
    },
    async (request) => {
      const { campaign_id } = request.params as { campaign_id: string };
      const query = request.query as { cursor?: string; limit?: number };
      const limit = query.limit ?? 50;
      const offset = cursorOffset(query.cursor);
      const items = await runtime.projection.tasks(campaign_id, limit + 1, offset);
      return offsetPage(items, offset, limit);
    },
  );

  app.get(
    "/api/v1/campaigns/:campaign_id/tasks/:task_id",
    {
      schema: {
        tags: ["campaigns"],
        response: { 200: taskDetailSchema, 404: cleanSchema(schemas.apiError) },
      },
    },
    async (request, reply) => {
      const { campaign_id, task_id } = request.params as {
        campaign_id: string;
        task_id: string;
      };
      const detail = await runtime.projection.task(campaign_id, task_id);
      if (!detail)
        return reply.code(404).send({
          error: {
            code: "not_found",
            message: "task was not found",
            request_id: request.id,
          },
        });
      return {
        task: detail.task,
        attempts: detail.attempts.map((attempt) => ({
          attempt_id: attempt.attempt_id,
          action_id: attempt.action_id,
          campaign_id: attempt.campaign_id,
          task_id: attempt.task_id,
          outcome: attempt.outcome,
          replacement_eligible: attempt.replacement_eligible,
          cost_microusd: attempt.cost_microusd,
          metrics: attempt.metrics,
          created_at: attempt.created_at,
        })),
      };
    },
  );

  app.get(
    "/api/v1/campaigns/:campaign_id/tasks/:task_id/action-dispositions",
    {
      schema: {
        tags: ["campaigns", "audit"],
        querystring: paginationQuerySchema,
        response: { 200: itemList(actionDispositionViewSchema) },
      },
    },
    async (request) => {
      const { campaign_id, task_id } = request.params as {
        campaign_id: string;
        task_id: string;
      };
      const query = request.query as { cursor?: string; limit?: number };
      const limit = query.limit ?? 50;
      const offset = cursorOffset(query.cursor);
      const items = await runtime.projection.actionDispositionViews(
        campaign_id,
        task_id,
        limit + 1,
        offset,
      );
      return offsetPage(items, offset, limit);
    },
  );

  app.post(
    "/api/v1/campaigns/:campaign_id/tasks/:task_id/action-dispositions",
    {
      schema: {
        tags: ["campaigns", "audit"],
        body: actionDispositionCorrectionSchema,
        response: {
          200: actionDispositionCorrectionResultSchema,
          201: actionDispositionCorrectionResultSchema,
        },
      },
    },
    async (request, reply) => {
      if (runtime.config.write_mode === "disabled")
        throw new ControlNotReadyError("campaign writes are disabled before cutover");
      const { campaign_id, task_id } = request.params as {
        campaign_id: string;
        task_id: string;
      };
      const result = await runtime.service.correctHistoricalSandboxAmbiguities(
        campaign_id,
        task_id,
        request.body as ActionDispositionCorrectionInput,
        idempotencyKey(request),
        domainActor(request),
      );
      return reply
        .code(result.items.some((item) => item.created) ? 201 : 200)
        .send(result);
    },
  );

  app.post(
    "/api/v1/campaigns/:campaign_id/actions",
    {
      schema: {
        tags: ["campaigns"],
        body: cleanSchema(schemas.campaignAction),
        response: { 202: acceptedSchema },
      },
    },
    async (request, reply) => {
      if (runtime.config.write_mode === "disabled")
        throw new ControlNotReadyError("campaign writes are disabled before cutover");
      const { campaign_id } = request.params as { campaign_id: string };
      const result = await runtime.service.campaignAction(
        campaign_id,
        request.body,
        idempotencyKey(request),
        domainActor(request),
      );
      return reply.code(202).send(result);
    },
  );

  app.post(
    "/api/v1/campaigns/:campaign_id/tasks/:task_id/attempts",
    {
      bodyLimit: 16 * 1024 * 1024,
      schema: {
        tags: ["campaigns"],
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
        throw new ControlNotReadyError("campaign writes are disabled before cutover");
      const { campaign_id, task_id } = request.params as {
        campaign_id: string;
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
        request.workerCapability.campaign_id !== campaign_id ||
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
          campaign_id,
          input.action_id,
          task_id,
          input.digest,
          bytes,
        );
        return reply.code(result.created ? 201 : 200).send(result);
      }
      const attemptId = deterministicId(
        "worker-attempt",
        campaign_id,
        task_id,
        sha256(requestKey),
      );
      const result = await runtime.service.attemptWithStatus(
        {
          campaign_id,
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
        campaign_id,
        task_id,
        attempt_id: attemptId,
        status_url: `/api/v1/campaigns/${campaign_id}/tasks/${task_id}`,
        adopted: result.adopted,
      });
    },
  );

  app.get(
    "/api/v1/jobs",
    {
      schema: {
        tags: ["resources"],
        querystring: jobsQuerySchema,
        response: { 200: itemList(jobSchema) },
      },
    },
    async (request) => {
      const query = request.query as {
        cursor?: string;
        limit?: number;
        campaign_id?: string;
      };
      const limit = query.limit ?? 50;
      const offset = cursorOffset(query.cursor);
      const items = await runtime.projection.jobs(limit + 1, offset, query.campaign_id);
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
          return redactSandboxTopology({
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
        querystring: {
          type: "object",
          properties: { cursor: { type: "string", maxLength: 1024 } },
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
      const seen = new Set<string>();
      const buffered: ControlEvent[] = [];
      let replaying = true;
      const unsubscribe = runtime.service.events.subscribe((event) => {
        if (replaying) buffered.push(event);
        else if (!seen.has(event.id)) {
          seen.add(event.id);
          sendEvent(reply, event);
        }
      });
      let replayCursor = cursor;
      while (replayCursor) {
        const page = await runtime.projection.audit(replayCursor, 500);
        for (const event of page) {
          seen.add(event.id);
          sendEvent(reply, event);
        }
        if (page.length < 500) break;
        replayCursor = page.at(-1)?.id ?? replayCursor;
      }
      replaying = false;
      for (const event of buffered) {
        if (!seen.has(event.id)) {
          seen.add(event.id);
          sendEvent(reply, event);
        }
      }
      const heartbeat = setInterval(
        () =>
          reply.raw.write(
            `data: ${JSON.stringify({ type: "heartbeat", occurred_at: new Date().toISOString(), data: {} })}\n\n`,
          ),
        15_000,
      );
      request.raw.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
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
    } else if (error instanceof SandboxActionAmbiguousError) {
      status = 503;
      code = "sandbox_action_ambiguous";
      message = "Sandbox action outcome is unknown and cannot be replayed";
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
