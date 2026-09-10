import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString, type OpenAPI3 } from "openapi-typescript";
import { z } from "zod";
import { hardwareCatalogSchema } from "./huggingface-hardware.js";
import { catalogSchema, validationSchema } from "./launch.js";
import { schemas } from "@harbor-hf/contracts";

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
const setupParameter = {
  name: "setup_test_id",
  in: "path",
  required: true,
  schema: { type: "string", minLength: 1, maxLength: 160 },
} as const;
const fileParameter = {
  name: "file_id",
  in: "path",
  required: true,
  schema: { type: "string", minLength: 1, maxLength: 160 },
} as const;
const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: { type: "string", minLength: 1, maxLength: 256 },
} as const;
const authenticated = [{ cookieSession: [] }, { bearerToken: [] }] as const;

const concurrentTrialsSchema = {
  type: "integer",
  minimum: 1,
  maximum: 128,
  description: "Harbor trial concurrency override.",
} as const;

// Embedded schemas share the OpenAPI document base URI. Lift definitions to
// real components: $defs is schema metadata, never a response property.
function embedSchema(name: string, source: object): Record<string, unknown> {
  const {
    $id: _id,
    $schema: _schema,
    $defs: definitions,
    ...body
  } = source as {
    $id?: string;
    $schema?: string;
    $defs?: Record<string, unknown>;
  };
  const components: Record<string, unknown> = { [name]: body };
  for (const [key, value] of Object.entries(definitions ?? {}))
    components[`${name}_${key}`] = value;
  return JSON.parse(
    JSON.stringify(components)
      .replaceAll("launch-pricing-v1.schema.json", "#/components/schemas/LaunchPricing")
      .replaceAll(
        "shared-estimate-v1.schema.json#/$defs/group",
        "#/components/schemas/SharedEstimate_group",
      )
      .replaceAll('"#/$defs/', `"#/components/schemas/${name}_`),
  ) as Record<string, unknown>;
}

const embeddedRunRecord = embedSchema("RunRecord", schemas.runRecord);

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
      ...embeddedRunRecord,
      ...embedSchema("LaunchPricing", schemas.launchPricing),
      ...embedSchema("SharedEstimate", schemas.sharedEstimate),
      ...embedSchema("LeaderboardRow", schemas.leaderboardRow),
      ...embedSchema("RunState", schemas.runState),
      ...embedSchema("RunPresentation", schemas.runPresentation),
      ...embedSchema("AgentTiming", schemas.agentTiming),
      RunView: {
        type: "object",
        required: ["record", "state", "status", "result"],
        properties: {
          record: { $ref: "#/components/schemas/RunRecord" },
          state: { $ref: "#/components/schemas/RunState" },
          status: {
            type: "string",
            enum: [
              "queued",
              "running",
              "paused",
              "cancelled",
              "finished",
              "cost_stopped",
            ],
          },
          result: { type: ["object", "null"], additionalProperties: true },
          presentation_available: {
            type: "boolean",
            description:
              "False when archive metadata cannot be validated or synchronized. Presentation is last-known only; null then means unknown, not unarchived. Ephemeral projection status, not durable metadata.",
          },
          presentation: {
            anyOf: [{ $ref: "#/components/schemas/RunPresentation" }, { type: "null" }],
          },
          agent_timing: { $ref: "#/components/schemas/AgentTiming" },
          shared_estimate: { $ref: "#/components/schemas/SharedEstimate" },
        },
      },
      TrialProgress: schemas.trialProgress,
      PresetSubmission: {
        type: "object",
        additionalProperties: false,
        required: ["benchmark", "model", "harness", "cost_ceiling_usd"],
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
          n_concurrent_trials: concurrentTrialsSchema,
          cost_ceiling_usd: {
            description:
              "Maximum reported trial-attempt cost for the complete campaign. Enforcement occurs after terminal attempts and can overshoot through concurrent work.",
            type: "number",
            exclusiveMinimum: 0,
            maximum: 10000,
          },
          role: { type: "string", enum: ["final", "diagnostic"], default: "final" },
        },
      },
      WorkbenchRecipe: {
        type: "object",
        additionalProperties: false,
        required: [
          "schema_version",
          "name",
          "setup_command",
          "run_command",
          "route_api",
          "setup_timeout_seconds",
          "environment",
          "outputs",
        ],
        properties: {
          schema_version: { const: "v1" },
          name: { type: "string" },
          setup_command: { type: "string" },
          run_command: { type: "string" },
          route_api: { type: "string", enum: ["chat-completions", "responses"] },
          setup_timeout_seconds: { type: "integer", minimum: 30, maximum: 3600 },
          environment: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "source"],
              properties: {
                name: { type: "string" },
                source: {
                  type: "string",
                  enum: [
                    "literal",
                    "instruction_path",
                    "workspace_path",
                    "logs_path",
                    "agent_home",
                    "model_name",
                    "model_base_url",
                    "model_api_key",
                  ],
                },
                value: { type: "string" },
              },
            },
          },
          outputs: {
            type: "object",
            additionalProperties: false,
            required: ["results_path", "trajectory_path"],
            properties: {
              results_path: { type: "string" },
              trajectory_path: { type: ["string", "null"] },
            },
          },
        },
      },
      WorkbenchSubmission: {
        type: "object",
        additionalProperties: false,
        required: ["benchmark", "model", "cost_ceiling_usd", "role", "workbench"],
        properties: {
          pricing: { $ref: "#/components/schemas/LaunchPricing" },
          n_concurrent_trials: concurrentTrialsSchema,
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
              reasoning_effort: { const: "off" },
            },
          },
          cost_ceiling_usd: {
            description:
              "Maximum reported trial-attempt cost for the complete campaign. Enforcement occurs after terminal attempts and can overshoot through concurrent work.",
            type: "number",
            exclusiveMinimum: 0,
            maximum: 10000,
          },
          role: { type: "string", enum: ["final", "diagnostic"] },
          workbench: {
            type: "object",
            additionalProperties: false,
            required: ["recipe", "setup_test_id"],
            properties: {
              recipe: { $ref: "#/components/schemas/WorkbenchRecipe" },
              setup_test_id: { type: "string", minLength: 1, maxLength: 160 },
              harbor_agent: {
                type: "object",
                additionalProperties: false,
                required: ["model_name"],
                properties: {
                  model_name: { type: "string", minLength: 1, maxLength: 320 },
                },
              },
            },
          },
        },
      },
      ModelProvidersResponse: {
        type: "object",
        additionalProperties: false,
        required: ["model", "providers"],
        properties: {
          model: { type: "string" },
          providers: { type: "array", items: { type: "string" } },
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
    "/api/v1/hardware": {
      get: {
        summary: "Read HF Jobs hardware specifications and prices",
        security: authenticated,
        responses: {
          "200": {
            description: "Current HF catalog; not a capacity or quota guarantee",
            content: {
              "application/json": { schema: z.toJSONSchema(hardwareCatalogSchema) },
            },
          },
          "401": error,
          "503": error,
        },
      },
    },
    "/api/v1/agents": {
      get: {
        summary: "List reviewed installed agents and native option schemas",
        security: authenticated,
        responses: {
          "200": {
            description: "Pinned Harbor catalog",
            content: { "application/json": { schema: z.toJSONSchema(catalogSchema) } },
          },
          "401": error,
          "503": error,
        },
      },
    },
    "/api/v1/runs/validate": {
      post: {
        summary:
          "Inspect native configuration without creating a run or executing agent code",
        security: authenticated,
        requestBody: { required: true, content: json },
        responses: {
          "200": {
            description:
              "Native plan counts and effective configuration; not an installation or inference test",
            content: {
              "application/json": { schema: z.toJSONSchema(validationSchema) },
            },
          },
          "400": error,
          "403": error,
          "503": error,
        },
      },
    },
    "/api/v1/model-providers": {
      get: {
        summary: "List live Hub inference providers for a model",
        security: authenticated,
        parameters: [
          {
            name: "model",
            in: "query",
            required: true,
            schema: { type: "string", minLength: 1, maxLength: 320 },
          },
        ],
        responses: {
          "200": {
            description: "Available providers",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ModelProvidersResponse" },
              },
            },
          },
          "400": error,
          "401": error,
          "404": error,
          "502": error,
        },
      },
    },
    "/api/v1/workbench/preview": {
      post: {
        summary: "Compile and validate a Workbench recipe",
        security: authenticated,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/WorkbenchRecipe" },
            },
          },
        },
        responses: { "200": ok, "400": error },
      },
    },
    "/api/v1/workbench/setup-tests": {
      get: {
        summary: "List setup tests owned by the current actor",
        security: authenticated,
        responses: { "200": ok, "401": error },
      },
      post: {
        summary: "Start a credentialless disposable setup test",
        security: authenticated,
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["recipe"],
                properties: {
                  recipe: { $ref: "#/components/schemas/WorkbenchRecipe" },
                },
              },
            },
          },
        },
        responses: { "202": ok, "400": error, "409": error },
      },
    },
    "/api/v1/workbench/setup-tests/{setup_test_id}": {
      get: {
        summary: "Read one actor-owned setup test",
        security: authenticated,
        parameters: [setupParameter],
        responses: { "200": ok, "404": error },
      },
    },
    "/api/v1/workbench/setup-tests/{setup_test_id}/cancel": {
      post: {
        summary: "Cancel one actor-owned setup test",
        security: authenticated,
        parameters: [setupParameter],
        responses: { "200": ok, "404": error },
      },
    },
    "/api/v1/workbench/setup-tests/{setup_test_id}/logs": {
      get: {
        summary: "Read bounded setup-test logs",
        security: authenticated,
        parameters: [setupParameter],
        responses: { "200": ok, "404": error },
      },
    },
    "/api/v1/workbench/setup-tests/{setup_test_id}/files/{file_id}": {
      get: {
        summary: "Read one bounded setup-test file preview",
        security: authenticated,
        parameters: [setupParameter, fileParameter],
        responses: { "200": ok, "404": error },
      },
    },
    "/api/v1/runs": {
      get: {
        summary: "List runs",
        security: authenticated,
        responses: {
          "200": {
            description: "Success",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["runs"],
                  properties: {
                    runs: {
                      type: "array",
                      items: { $ref: "#/components/schemas/RunView" },
                    },
                  },
                },
              },
            },
          },
          "401": error,
        },
      },
      post: {
        summary: "Submit a reviewed preset or attested Workbench run",
        security: authenticated,
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  { $ref: "#/components/schemas/PresetSubmission" },
                  { $ref: "#/components/schemas/WorkbenchSubmission" },
                ],
              },
            },
          },
        },
        responses: { "200": ok, "201": ok, "400": error, "409": error },
      },
    },
    "/api/v1/runs/config": {
      post: {
        summary: "Validate and submit a diagnostic native Harbor JobConfig",
        security: authenticated,
        parameters: [
          idempotencyHeader,
          {
            name: "X-Harbor-HF-Validation",
            in: "header",
            required: false,
            description:
              "Fingerprint from Validate. A changed configuration or policy returns 409.",
            schema: { type: "string" },
          },
          {
            name: "X-Harbor-HF-Cost-Ceiling-USD",
            in: "header",
            required: true,
            description:
              "Maximum reported trial-attempt cost for the complete campaign.",
            schema: { type: "number", exclusiveMinimum: 0 },
          },
        ],
        requestBody: { required: true, content: json },
        responses: {
          "200": ok,
          "201": ok,
          "400": error,
          "409": error,
          "503": error,
        },
      },
    },
    "/api/v1/runs/{run_id}": {
      get: {
        summary: "Read one run",
        security: authenticated,
        parameters: [runParameter],
        responses: {
          "200": {
            description: "Success",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/RunView" } },
            },
          },
          "404": error,
        },
      },
    },
    "/api/v1/runs/{run_id}/presentation": {
      patch: {
        summary: "Archive or restore shared Runs visibility (operator only)",
        parameters: [runParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["archived", "expected_revision"],
                properties: {
                  archived: { type: "boolean" },
                  expected_revision: {
                    type: "integer",
                    minimum: 0,
                    maximum: Number.MAX_SAFE_INTEGER,
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Current presentation; null means never archived",
            content: {
              "application/json": {
                schema: {
                  anyOf: [
                    { $ref: "#/components/schemas/RunPresentation" },
                    { type: "null" },
                  ],
                },
              },
            },
          },
          "400": { description: "Invalid request" },
          "403": { description: "Operator or CSRF required" },
          "409": {
            description:
              "Stale revision; validated current metadata synchronized for the next GET",
          },
          "503": {
            description:
              "Writes disabled or presentation unavailable; require validated synchronization before retrying",
          },
        },
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
    "/api/v1/runs/{run_id}/progress": {
      get: {
        summary:
          "Observe native trial artifacts and run-owned HF Jobs (not a scheduler)",
        security: authenticated,
        parameters: [runParameter],
        responses: {
          "200": {
            description: "Allowlisted artifact observations",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TrialProgress" },
              },
            },
          },
          "404": error,
        },
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
      get: {
        summary: "Read the public leaderboard",
        responses: {
          "200": {
            description: "Success",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["rows"],
                  properties: {
                    rows: {
                      type: "array",
                      items: { $ref: "#/components/schemas/LeaderboardRow" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

const documentPath = join(repository, "docs", "control-api-v1.openapi.json");
await writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
const generated = astToString(
  await openapiTS(document as unknown as OpenAPI3, { emptyObjectsUnknown: true }),
);
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
