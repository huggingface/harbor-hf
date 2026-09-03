import { readFile } from "node:fs/promises";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import { ContractValidationError } from "@harbor-hf/contracts";
import { leaderboard } from "@harbor-hf/control-core";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z } from "zod";
import {
  BearerRateLimitError,
  type AuthenticatedActor,
  InvalidBearerCredentialError,
  type SessionRow,
} from "./auth.js";
import type { Runtime } from "./runtime.js";

export const HARBOR_REVISION = "dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e";

const submissionSchema = z
  .object({
    benchmark: z
      .object({ name: z.string().min(1), preset: z.string().min(1) })
      .strict(),
    model: z
      .object({
        id: z.string().min(1).max(320),
        provider: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
        reasoning_effort: z.string().min(1).max(40),
      })
      .strict(),
    harness: z
      .object({ agent: z.string().min(1), version: z.string().min(1) })
      .strict(),
    cost_ceiling_usd_per_trial: z.number().positive().max(10_000),
    role: z.enum(["final", "diagnostic"]).default("final"),
  })
  .strict();

const runParameters = z.object({ run_id: z.string().regex(/^run-[0-9a-f]{24}$/) });
const trialParameters = runParameters.extend({ trial_name: z.string().min(1) });
const embeddedCookiePolicy = {
  httpOnly: true,
  secure: true,
  sameSite: "none" as const,
  partitioned: true,
};

interface RequestState {
  actor: AuthenticatedActor | null;
  session: SessionRow | null;
}

function state(request: FastifyRequest): RequestState {
  return (request as FastifyRequest & { controlState: RequestState }).controlState;
}

function error(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

async function authenticate(
  runtime: Runtime,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const requestState = state(request);
  if (runtime.config.auth_mode === "development") {
    requestState.actor = runtime.auth.developmentActor();
    return true;
  }
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    try {
      requestState.actor = await runtime.auth.bearerActor(
        authorization.slice("Bearer ".length),
      );
      return true;
    } catch (failure) {
      if (failure instanceof BearerRateLimitError) {
        await reply.header("Retry-After", "60");
        error(reply, 429, "rate_limit_exceeded", "bearer lookup rate exceeded");
        return false;
      }
      if (!(failure instanceof InvalidBearerCredentialError)) throw failure;
      error(reply, 401, "unauthorized", "the bearer credential is invalid");
      return false;
    }
  }
  const sessionId = request.cookies.hhf_session;
  if (!sessionId) {
    error(reply, 401, "unauthorized", "sign in is required");
    return false;
  }
  const authenticated = await runtime.auth.sessionActor(sessionId);
  if (!authenticated) {
    error(reply, 401, "unauthorized", "the session is invalid or expired");
    return false;
  }
  requestState.actor = authenticated.actor;
  requestState.session = authenticated.session;
  if (!["GET", "HEAD"].includes(request.method)) {
    const token = request.headers["x-csrf-token"];
    if (
      typeof token !== "string" ||
      !runtime.auth.csrfValid(authenticated.session, token)
    ) {
      error(reply, 403, "csrf_rejected", "the CSRF token is invalid");
      return false;
    }
  }
  return true;
}

function requireActor(request: FastifyRequest): AuthenticatedActor {
  const actor = state(request).actor;
  if (!actor) throw new Error("authenticated actor is missing");
  return actor;
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !value.trim() || value.length > 320)
    throw new Error("Idempotency-Key header is required");
  return value;
}

function publicApi(path: string): boolean {
  return path === "/api/v1/leaderboard" || path === "/api/v1/session";
}

export async function buildApp(runtime: Runtime): Promise<FastifyInstance> {
  const app = Fastify({ logger: runtime.config.node_env !== "test" });
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
  app.decorateRequest("controlState", null);
  app.addHook("onRequest", async (request) => {
    (request as FastifyRequest & { controlState: RequestState }).controlState = {
      actor: null,
      session: null,
    };
  });
  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (!path.startsWith("/api/v1/") || publicApi(path)) return;
    if (!(await authenticate(runtime, request, reply))) return reply;
    const mutation = request.method !== "GET" && request.method !== "HEAD";
    if (mutation && requireActor(request).role !== "operator")
      return error(reply, 403, "operator_required", "operator access is required");
    if (mutation && runtime.config.write_mode !== "enabled")
      return error(reply, 503, "write_disabled", "write mode is disabled");
  });

  app.setErrorHandler((failure, _request, reply) => {
    if (reply.sent) return;
    if (failure instanceof z.ZodError || failure instanceof ContractValidationError)
      return error(reply, 400, "invalid_request", "the request is invalid");
    const message = failure instanceof Error ? failure.message : "request failed";
    if (message.includes("not found")) return error(reply, 404, "not_found", message);
    if (message.includes("already identifies") || message.includes("cancelled run"))
      return error(reply, 409, "conflict", message);
    if (
      /Idempotency-Key|preset|reasoning|cost ceiling|JobConfig|credential literal|environment|agent/.test(
        message,
      )
    )
      return error(reply, 400, "invalid_request", message);
    app.log.error(
      { error_name: failure instanceof Error ? failure.name : "Error" },
      "request failed",
    );
    return error(reply, 500, "internal_error", "the request failed");
  });

  app.get("/health/live", async () => ({ status: "live" }));
  app.get("/health/ready", async (_request, reply) =>
    runtime.ready
      ? { status: "ready" }
      : reply.code(503).send({ status: "initializing" }),
  );

  app.get("/auth/login", async (request, reply) => {
    if (runtime.config.auth_mode === "development") return reply.redirect("/");
    const query = z
      .object({ return_to: z.string().optional().default("/") })
      .parse(request.query);
    const login = await runtime.auth.login(query.return_to);
    reply.setCookie("hhf_oauth_flow", login.flow_id, {
      ...embeddedCookiePolicy,
      path: "/auth/callback",
      maxAge: 600,
    });
    return reply.redirect(login.url.toString());
  });

  app.get("/auth/callback", async (request, reply) => {
    const flowId = request.cookies.hhf_oauth_flow;
    if (!flowId) return error(reply, 400, "oauth_failed", "OAuth flow is missing");
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
  });

  app.post("/auth/logout", async (request, reply) => {
    const sessionId = request.cookies.hhf_session;
    if (sessionId) runtime.auth.store.deleteSession(sessionId);
    reply.clearCookie("hhf_session", { ...embeddedCookiePolicy, path: "/" });
    reply.clearCookie("hhf_csrf", { ...embeddedCookiePolicy, path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/v1/session", async (request, reply) => {
    if (!(await authenticate(runtime, request, reply)))
      return { authenticated: false, login_url: "/auth/login" };
    const actor = requireActor(request);
    return {
      authenticated: true,
      actor: { username: actor.username, role: actor.role, transport: actor.transport },
    };
  });

  app.get("/api/v1/system", async () => ({
    source_revision: runtime.config.source_revision,
    harbor_revision: HARBOR_REVISION,
    write_mode: runtime.config.write_mode,
    ready: runtime.ready,
    projection: runtime.projection.system(),
    capacity: { max_active_parent_jobs: runtime.config.max_active_jobs },
    resources: { spaces: 1, buckets: 1, operator_secrets: 2 },
  }));

  app.get("/api/v1/presets", async () => ({
    benchmarks: runtime.presets.benchmarks,
    agents: runtime.presets.agents,
  }));

  app.post("/api/v1/runs", async (request, reply) => {
    const actor = requireActor(request);
    const result = await runtime.service.submitPreset(
      submissionSchema.parse(request.body),
      idempotencyKey(request),
      actor.subject,
    );
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.post("/api/v1/runs/config", async (request, reply) => {
    const actor = requireActor(request);
    const ceiling = Number(request.headers["x-harbor-hf-cost-ceiling-usd-per-trial"]);
    const result = await runtime.service.submitConfig(
      request.body,
      ceiling,
      idempotencyKey(request),
      actor.subject,
    );
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.get("/api/v1/runs", async () => ({ runs: runtime.projection.listRuns() }));
  app.get("/api/v1/runs/:run_id", async (request) => {
    const { run_id } = runParameters.parse(request.params);
    const run = runtime.projection.run(run_id);
    if (!run) throw new Error("run was not found");
    return run;
  });

  for (const [action, desired] of [
    ["pause", "paused"],
    ["resume", "run"],
    ["cancel", "cancelled"],
  ] as const) {
    app.post(`/api/v1/runs/:run_id/${action}`, async (request) => {
      const actor = requireActor(request);
      const { run_id } = runParameters.parse(request.params);
      return runtime.service.setDesiredState(run_id, desired, actor.subject);
    });
  }

  app.get("/api/v1/runs/:run_id/trials", async (request) => {
    const { run_id } = runParameters.parse(request.params);
    if (!runtime.projection.run(run_id)) throw new Error("run was not found");
    return {
      trials: runtime.projection
        .trials(run_id)
        .map(({ result: _result, ...trial }) => trial),
    };
  });

  app.get("/api/v1/runs/:run_id/trials/:trial_name", async (request) => {
    const { run_id, trial_name } = trialParameters.parse(request.params);
    const trial = runtime.projection
      .trials(run_id)
      .find((item) => item.trial_name === trial_name);
    if (!trial) throw new Error("trial was not found");
    return trial;
  });

  app.get("/api/v1/jobs", async () => ({ jobs: runtime.projection.jobs() }));
  app.get("/api/v1/leaderboard", async () => ({
    rows: leaderboard(runtime.projection, runtime.presets),
  }));

  await app.register(fastifyStatic, {
    root: runtime.config.web_root,
    wildcard: false,
  });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/") || request.url.startsWith("/auth/"))
      return error(reply, 404, "not_found", "route was not found");
    if (request.method !== "GET")
      return error(reply, 404, "not_found", "route was not found");
    const index = await readFile(`${runtime.config.web_root}/index.html`, "utf8");
    return reply.type("text/html; charset=utf-8").send(index);
  });
  return app;
}
