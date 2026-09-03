import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString, type OpenAPI3 } from "openapi-typescript";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const json = { "application/json": { schema: { type: "object" } } } as const;
const ok = { description: "Success", content: json } as const;
const error = {
  description: "Request error",
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
  },
} as const;
const runParameter = {
  name: "run_id",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^run-[0-9a-f]{24}$" },
} as const;
const trialParameter = {
  name: "trial_name",
  in: "path",
  required: true,
  schema: { type: "string" },
} as const;
const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: { type: "string", minLength: 1, maxLength: 256 },
} as const;
const authenticated = [{ cookieSession: [] }, { bearerToken: [] }] as const;

const document = {
  openapi: "3.1.0",
  info: {
    title: "Harbor-HF control API",
    version: "v1",
    description: "Submit Harbor runs and inspect their projected state.",
  },
  components: {
    securitySchemes: {
      cookieSession: { type: "apiKey", in: "cookie", name: "hhf_session" },
      bearerToken: { type: "http", scheme: "bearer" },
    },
    schemas: {
      PresetSubmission: {
        type: "object",
        additionalProperties: false,
        required: ["benchmark", "model", "harness", "cost_ceiling_usd_per_trial"],
        properties: {
          benchmark: {
            type: "object",
            additionalProperties: false,
            required: ["name", "preset"],
            properties: {
              name: { type: "string" },
              preset: { type: "string" },
            },
          },
          model: {
            type: "object",
            additionalProperties: false,
            required: ["id", "provider", "reasoning_effort"],
            properties: {
              id: { type: "string" },
              provider: { type: "string" },
              reasoning_effort: { type: "string" },
            },
          },
          harness: {
            type: "object",
            additionalProperties: false,
            required: ["agent", "version"],
            properties: {
              agent: { type: "string" },
              version: { type: "string" },
            },
          },
          cost_ceiling_usd_per_trial: {
            type: "number",
            exclusiveMinimum: 0,
            maximum: 10000,
          },
          role: { type: "string", enum: ["final", "diagnostic"], default: "final" },
        },
      },
    },
  },
  paths: {
    "/api/v1/session": {
      get: { summary: "Read the current session", responses: { "200": ok } },
    },
    "/api/v1/system": {
      get: {
        summary: "Read system state",
        security: authenticated,
        responses: { "200": ok, "401": error },
      },
    },
    "/api/v1/presets": {
      get: {
        summary: "List benchmark and agent presets",
        security: authenticated,
        responses: { "200": ok, "401": error },
      },
    },
    "/api/v1/runs": {
      get: {
        summary: "List runs",
        security: authenticated,
        responses: { "200": ok, "401": error },
      },
      post: {
        summary: "Submit a preset run",
        security: authenticated,
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PresetSubmission" },
            },
          },
        },
        responses: { "200": ok, "201": ok, "400": error, "409": error },
      },
    },
    "/api/v1/runs/config": {
      post: {
        summary: "Submit a direct Harbor JobConfig",
        security: authenticated,
        parameters: [
          idempotencyHeader,
          {
            name: "X-Harbor-HF-Cost-Ceiling-USD-Per-Trial",
            in: "header",
            required: true,
            schema: { type: "number", exclusiveMinimum: 0 },
          },
        ],
        requestBody: { required: true, content: json },
        responses: { "200": ok, "201": ok, "400": error, "409": error },
      },
    },
    "/api/v1/runs/{run_id}": {
      get: {
        summary: "Read one run",
        security: authenticated,
        parameters: [runParameter],
        responses: { "200": ok, "404": error },
      },
    },
    "/api/v1/runs/{run_id}/pause": {
      post: {
        summary: "Pause a run",
        security: authenticated,
        parameters: [runParameter],
        responses: { "200": ok, "404": error },
      },
    },
    "/api/v1/runs/{run_id}/resume": {
      post: {
        summary: "Resume a run",
        security: authenticated,
        parameters: [runParameter],
        responses: { "200": ok, "404": error, "409": error },
      },
    },
    "/api/v1/runs/{run_id}/cancel": {
      post: {
        summary: "Cancel a run",
        security: authenticated,
        parameters: [runParameter],
        responses: { "200": ok, "404": error },
      },
    },
    "/api/v1/runs/{run_id}/trials": {
      get: {
        summary: "List trials for one run",
        security: authenticated,
        parameters: [runParameter],
        responses: { "200": ok, "404": error },
      },
    },
    "/api/v1/runs/{run_id}/trials/{trial_name}": {
      get: {
        summary: "Read one trial result",
        security: authenticated,
        parameters: [runParameter, trialParameter],
        responses: { "200": ok, "404": error },
      },
    },
    "/api/v1/jobs": {
      get: {
        summary: "List parent Jobs",
        security: authenticated,
        responses: { "200": ok, "401": error },
      },
    },
    "/api/v1/leaderboard": {
      get: { summary: "Read the public leaderboard", responses: { "200": ok } },
    },
  },
} as const;

const documentPath = join(repository, "docs", "control-api-v1.openapi.json");
await writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
const generated = astToString(await openapiTS(document as unknown as OpenAPI3));
const outputPath = join(
  repository,
  "apps",
  "control-web",
  "src",
  "generated",
  "api.ts",
);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, generated, "utf8");
