import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { containsCredentialMaterial } from "@harbor-hf/control-core";
import { PersonalHuggingFace } from "@harbor-hf/hf-adapters";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthenticatedActor } from "./auth.js";
import type { Runtime } from "./runtime.js";

const component = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
const submission = z
  .object({
    benchmark: z.object({ name: component, preset: component }).strict(),
    harness: z
      .object({ agent: component, version: z.string().min(1).max(100) })
      .strict(),
    model: z
      .object({
        id: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        provider: component,
        reasoning_effort: component,
      })
      .strict(),
    cost_ceiling_usd_per_trial: z.number().positive().finite(),
  })
  .strict();
const approvalSchema = z
  .object({
    run_id: z.string().regex(/^run-[0-9a-f]{24}$/),
    owner: component,
    results_bucket: component,
    submission,
    image: z.string().regex(/^[^\s]+@sha256:[0-9a-f]{64}$/),
    hardware: z.enum(["cpu-basic", "cpu-upgrade"]),
    runtime_seconds: z.number().int().positive().max(82_800),
    job_timeout_seconds: z.number().int().positive().max(86_400),
    expires_at: z.iso.datetime(),
    total_budget_usd: z.number().positive().finite(),
    inference_limit_usd: z.number().positive().finite(),
    native_config_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    credential_source: z.literal("supplied-user-token"),
    credential_destinations: z.literal(
      "control-request,hf-job-secret,harbor,sandbox,agent,hf-inference,hf-bucket",
    ),
    deployment_scope: z.literal("dedicated-user-owned-hf-job"),
    cleanup: z.literal("selected-parent-only;children-best-effort"),
    limits_reviewed: z.literal(true),
  })
  .strict();

async function approval(runtime: Runtime, owner: string) {
  if (!runtime.config.personal_approval_file) return null;
  const value = approvalSchema.parse(
    JSON.parse(await readFile(runtime.config.personal_approval_file, "utf8")),
  );
  if (value.owner !== owner || Date.parse(value.expires_at) <= Date.now()) return null;
  if (containsCredentialMaterial(value.submission))
    throw new Error("Submission contains credential material");
  if (
    value.job_timeout_seconds < value.runtime_seconds + 120 ||
    value.inference_limit_usd > value.total_budget_usd
  )
    throw new Error("Invalid launch limits");
  const config = runtime.presets.buildJobConfig(
    value.run_id,
    value.submission,
    "/data",
  );
  const digest = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  if (digest !== value.native_config_sha256) throw new Error("Approval is stale");
  return {
    value,
    config,
    digest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  };
}

export function registerPersonalRoutes(
  app: FastifyInstance,
  runtime: Runtime,
  actorFor: (request: FastifyRequest) => AuthenticatedActor,
) {
  const busy = new Set<string>();
  app.post("/api/v1/personal/:action", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const { action } = z
      .object({
        action: z.enum([
          "identity",
          "preview",
          "approval",
          "jobs",
          "logs",
          "cancel",
          "results",
          "artifact",
          "launch",
        ]),
      })
      .parse(request.params);
    // Static catalog compilation needs login/CSRF, not Jobs credentials.
    if (action === "preview") {
      const input = z
        .object({ run_id: component, submission })
        .strict()
        .parse(request.body);
      if (containsCredentialMaterial(input.submission))
        throw new Error("Harbor JobConfig submission contains credential material");
      const config = runtime.presets.buildJobConfig(
        input.run_id,
        input.submission,
        "/data",
      );
      return {
        config,
        native_config_sha256: createHash("sha256")
          .update(JSON.stringify(config))
          .digest("hex"),
      };
    }
    const token = request.headers["x-hf-user-token"];
    if (
      typeof token !== "string" ||
      !/^hf_[A-Za-z0-9]{8,256}$/.test(token) ||
      token === runtime.config.hf_token
    )
      return reply.code(401).send({
        error: {
          code: "user_token_required",
          message: "Supply a separate user token.",
        },
      });
    const personal = new PersonalHuggingFace(token);
    try {
      const identity = await personal.identity();
      const actor = actorFor(request);
      const matches =
        actor.transport === "session"
          ? actor.username === identity.name
          : actor.subject === identity.id;
      if (!matches)
        return reply.code(403).send({
          error: {
            code: "identity_mismatch",
            message: "Token identity must match login.",
          },
        });
      const owner = component.parse(identity.name);
      if (action === "identity") return { owner };
      if (action === "jobs") return { jobs: await personal.jobs(owner) };
      if (action === "approval") {
        const approved = await approval(runtime, owner);
        return {
          approval: approved
            ? { ...approved.value, approval_sha256: approved.digest }
            : null,
        };
      }
      if (action === "logs" || action === "cancel") {
        const input = z
          .object({
            job_id: component,
            ...(action === "cancel" ? { confirm: z.literal(true) } : {}),
          })
          .strict()
          .parse(request.body);
        return action === "logs"
          ? await personal.logs(owner, input.job_id)
          : await personal.cancel(owner, input.job_id);
      }
      if (action === "results" || action === "artifact") {
        const input = z
          .object({
            bucket: component,
            run_id: component,
            ...(action === "artifact" ? { path: z.string().max(2048) } : {}),
          })
          .strict()
          .parse(request.body);
        if (action === "results")
          return await personal.results(owner, input.bucket, input.run_id);
        const path = String(input.path);
        if (
          !path.startsWith(`runs/${input.run_id}/`) ||
          path.split("/").some((part) => !part || part === "." || part === "..") ||
          path.includes("\\") ||
          [...path].some((character) => character.charCodeAt(0) < 32)
        )
          throw new Error("Invalid artifact path");
        return await personal.artifact(owner, input.bucket, path);
      }
      const input = z
        .object({
          run_id: component,
          approval_sha256: z.string().regex(/^[0-9a-f]{64}$/),
          confirm: z.literal(true),
          accept_best_effort_cleanup_and_external_cost_limits: z.literal(true),
        })
        .strict()
        .parse(request.body);
      const approved = await approval(runtime, owner);
      if (
        !approved ||
        input.run_id !== approved.value.run_id ||
        input.approval_sha256 !== approved.digest
      )
        return reply.code(503).send({
          error: {
            code: "launch_not_approved",
            message: "Exact launch approval is required.",
          },
        });
      const { value, config } = approved;
      if (busy.has(value.run_id)) throw new Error("Launch already claimed");
      busy.add(value.run_id);
      try {
        // Persist BEFORE the provider call. Ambiguous dispatch is never retried.
        const claim = await runtime.store.create(
          `personal-admissions/${value.run_id}/claim.json`,
          Buffer.from(JSON.stringify({ owner, run_id: value.run_id })),
        );
        if (!claim.created)
          return reply.code(409).send({
            error: {
              code: "launch_already_claimed",
              message:
                "Approval consumed. Inspect personal Jobs; do not blindly retry.",
            },
          });
        const job = await personal.launch({
          owner,
          bucket: value.results_bucket,
          runId: value.run_id,
          image: value.image,
          hardware: value.hardware,
          runtimeSeconds: value.runtime_seconds,
          jobTimeoutSeconds: value.job_timeout_seconds,
          config,
        });
        await runtime.store.put(
          `personal-admissions/${value.run_id}/job.json`,
          Buffer.from(JSON.stringify(job)),
        );
        return job;
      } finally {
        busy.delete(value.run_id);
      }
    } catch {
      // No provider exceptions or request bodies in responses or service logs.
      return reply.code(400).send({
        error: {
          code: "personal_request_failed",
          message:
            "Personal request failed. Check token permissions and inputs. If launching, inspect personal Jobs before any further action.",
        },
      });
    }
  });
}
