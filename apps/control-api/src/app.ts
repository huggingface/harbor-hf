import { existsSync } from "node:fs";
import type {
  Actor,
  AttemptSubmissionV1,
  CampaignSubmissionV1,
  HarborHFResultCatalogV1,
} from "@harbor-hf/contracts";
import {
  deterministicId,
  schemas,
  sha256,
  validateResultCatalog,
} from "@harbor-hf/contracts";
import {
  ConfirmationRequiredError,
  ControlNotReadyError,
  IdempotencyConflictError,
  PolicyError,
  ProfileResolutionError,
  type ControlEvent,
  type WorkerCapability,
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
  actionSchema,
  attemptAcceptedSchema,
  auditSchema,
  campaignListSchema,
  campaignViewSchema,
  endpointSchema,
  evidenceAcceptedSchema,
  evidenceUploadSchema,
  itemList,
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
    (request.method === "GET" && /^\/api\/v1\/campaigns\/[^/]+\/lock$/.test(path)) ||
    (request.method === "POST" &&
      /^\/api\/v1\/campaigns\/[^/]+\/tasks\/[^/]+\/attempts$/.test(path))
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

function cursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^\d+$/.test(text)) throw new PolicyError("cursor is invalid");
  return Number(text);
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

function cleanSchema(value: object): object {
  const clone = structuredClone(value) as Record<string, unknown>;
  delete clone.$schema;
  delete clone.$id;
  return clone;
}

function sendEvent(reply: FastifyReply, event: ControlEvent): void {
  reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
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
      });
    }
  }
  return [...byId.values()].sort((left, right) => {
    const byTime = String(right.published_at).localeCompare(String(left.published_at));
    return (
      byTime || String(right.publication_id).localeCompare(String(left.publication_id))
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
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
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
        httpOnly: true,
        secure: true,
        sameSite: "lax",
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
      reply.clearCookie("hhf_oauth_flow", { path: "/auth/callback" });
      reply.setCookie("hhf_session", callback.session_id, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/",
        expires: new Date(callback.expires_at),
      });
      reply.setCookie("hhf_csrf", callback.csrf, {
        httpOnly: false,
        secure: true,
        sameSite: "strict",
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
      reply.clearCookie("hhf_session", { path: "/" });
      reply.clearCookie("hhf_csrf", { path: "/" });
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/v1/auth/session",
    {
      schema: { tags: ["auth"], response: { 200: sessionSchema, 401: sessionSchema } },
    },
    async (request, reply) => {
      if (runtime.config.auth_mode === "development")
        return { authenticated: true, actor: runtime.auth.developmentActor() };
      const sessionId = request.cookies.hhf_session;
      const authenticated =
        request.actor && request.authSession
          ? { actor: request.actor, session: request.authSession }
          : sessionId
            ? await runtime.auth.sessionActor(sessionId)
            : null;
      if (!authenticated)
        return reply.code(401).send({ authenticated: false, login_url: "/auth/login" });
      return { authenticated: true, actor: authenticated.actor };
    },
  );

  app.get(
    "/api/v1/system",
    { schema: { tags: ["system"], response: { 200: systemSchema } } },
    async () => ({
      source_revision: runtime.config.source_revision,
      write_mode: runtime.config.write_mode,
      projection: runtime.projection.system(),
      resource_contract: { spaces: 1, buckets: 1, operator_secrets: 1 },
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
      if (lock && request.workerCapability)
        return {
          ...lock,
          tasks: lock.tasks.filter((task) =>
            request.workerCapability?.task_ids.includes(task.task_id),
          ),
        };
      return (
        lock ??
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
      if (
        request.workerCapability.campaign_id !== campaign_id ||
        request.workerCapability.action_id !== input.action_id ||
        !request.workerCapability.task_ids.includes(task_id)
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
        querystring: paginationQuerySchema,
        response: { 200: itemList(actionSchema) },
      },
    },
    async (request) => {
      const query = request.query as { cursor?: string; limit?: number };
      const limit = query.limit ?? 50;
      const offset = cursorOffset(query.cursor);
      const items = await runtime.projection.jobs(limit + 1, offset);
      return offsetPage(items, offset, limit);
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
      return offsetPage(items, offset, limit);
    },
  );
  app.get(
    "/api/v1/results",
    {
      schema: {
        tags: ["results"],
        querystring: paginationQuerySchema,
        response: { 200: itemList(publicationSchema) },
      },
    },
    async (request) => {
      const query = request.query as { cursor?: string; limit?: number };
      const limit = query.limit ?? 50;
      const offset = cursorOffset(query.cursor);
      const items = (await resultItems(runtime)).slice(offset, offset + limit + 1);
      return offsetPage(items, offset, limit);
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
      for (;;) {
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
      const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
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
