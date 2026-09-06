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

const document = {
  openapi: "3.1.0",
  info: {
    title: "Harbor-HF control API",
    version: "v1",
    description:
      "Native configuration authoring and personal HF execution. Historical Run and setup mutations remain disabled. Personal dispatch requires exact server approval and a matching supplied user token.",
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
        required: [
          "benchmark",
          "model",
          "cost_ceiling_usd_per_trial",
          "role",
          "workbench",
        ],
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
              reasoning_effort: { const: "off" },
            },
          },
          cost_ceiling_usd_per_trial: {
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
    "/api/v1/personal/{action}": {
      post: {
        summary: "Operate on the verified user's HF Jobs and private results",
        description:
          "Preview requires login only and makes no provider calls. All other actions require a supplied user token matching the authenticated identity. Session requests also require X-CSRF-Token. No credential is persisted. Launch additionally consumes an exact server-side approval; historical execution remains disabled.",
        security: authenticated,
        parameters: [
          {
            name: "action",
            in: "path",
            required: true,
            schema: {
              type: "string",
              enum: [
                "identity",
                "preview",
                "approval",
                "jobs",
                "logs",
                "cancel",
                "results",
                "artifact",
                "launch",
                "setup-result",
              ],
            },
          },
          {
            name: "X-HF-User-Token",
            in: "header",
            required: false,
            description: "Required for all actions except preview.",
            schema: { type: "string", writeOnly: true },
          },
        ],
        requestBody: { required: true, content: json },
        responses: {
          "200": ok,
          "400": error,
          "401": error,
          "403": error,
          "409": error,
          "503": error,
        },
      },
    },
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
    "/api/v1/workbench/configurations": {
      get: {
        summary: "List owner-scoped immutable native Harbor configurations",
        security: authenticated,
        responses: { "200": ok },
      },
      post: {
        summary:
          "Save an owner-scoped configuration independently of control write mode",
        security: authenticated,
        responses: { "200": ok, "400": error, "401": error, "403": error },
      },
    },
    "/api/v1/workbench/starters": {
      get: {
        summary: "Read native Fast-Agent and FX authoring starters",
        security: authenticated,
        responses: { "200": ok, "401": error },
      },
    },
    "/api/v1/workbench/setup-results": {
      get: {
        summary: "Read own setup evidence receipts, not leaderboard verification",
        security: authenticated,
        responses: { "200": ok, "401": error },
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
        responses: { "200": ok, "401": error },
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

const disabledDocument: OpenAPI3 = structuredClone(document) as unknown as OpenAPI3;
for (const [path, item] of Object.entries(disabledDocument.paths ?? {})) {
  if (
    item &&
    "post" in item &&
    item.post &&
    !("$ref" in item.post) &&
    (path.startsWith("/api/v1/runs") ||
      path.startsWith("/api/v1/workbench/setup-tests"))
  ) {
    item.post.summary = "Execution disabled: no admission or Job action";
    item.post.responses = { "503": error } as unknown as NonNullable<
      typeof item.post.responses
    >;
  }
}

const documentPath = join(repository, "docs", "control-api-v1.openapi.json");
await writeFile(documentPath, `${JSON.stringify(disabledDocument, null, 2)}\n`, "utf8");
const generated = astToString(await openapiTS(disabledDocument));
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
