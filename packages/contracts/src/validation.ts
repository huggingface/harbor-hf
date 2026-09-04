import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type {
  AgentPresetV1,
  AgentWorkbenchRecipeV1,
  AttemptCostV1,
  BenchmarkPresetV1,
  HarborJobConfigV1,
  RunRecordV1,
  RunStateV1,
  SavedWorkbenchConfigurationV1,
} from "./generated/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");

function load(name: string): object {
  return JSON.parse(readFileSync(join(root, name), "utf8")) as object;
}

export const schemas = {
  savedWorkbench: load("saved-workbench-v1.schema.json"),
  agentPreset: load("agent-preset-v1.schema.json"),
  agentWorkbenchRecipe: load("agent-workbench-v1.schema.json"),
  attemptCost: load("attempt-cost-v1.schema.json"),
  benchmarkPreset: load("benchmark-preset-v1.schema.json"),
  harborJobConfig: load("harbor-job-config-v1.schema.json"),
  runRecord: load("run-record-v1.schema.json"),
  runState: load("run-state-v1.schema.json"),
} as const;

function closeSchemaObjects(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(closeSchemaObjects);
  if (!value || typeof value !== "object") return value;
  const closed = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, closeSchemaObjects(child)]),
  );
  if (
    closed.type === "object" &&
    closed.properties &&
    closed.additionalProperties === undefined
  )
    closed.additionalProperties = false;
  return closed;
}

function configuredAjv(): Ajv2020 {
  const instance = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strict: false,
  });
  instance.addFormat("date-time", {
    type: "string",
    validate: (value: string) => Number.isFinite(Date.parse(value)),
  });
  instance.addFormat("path", { type: "string", validate: () => true });
  instance.addFormat("uuid", {
    type: "string",
    validate: (value: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
  });
  return instance;
}

const ajv = configuredAjv();
const strictAjv = configuredAjv();
ajv.addSchema(
  schemas.harborJobConfig,
  "https://harborframework.com/schemas/harbor-hf/harbor-job-config-v1.schema.json",
);
const validators = {
  savedWorkbench: ajv.compile(schemas.savedWorkbench),
  agentPreset: ajv.compile(schemas.agentPreset),
  agentWorkbenchRecipe: ajv.compile(schemas.agentWorkbenchRecipe),
  attemptCost: ajv.compile(schemas.attemptCost),
  benchmarkPreset: ajv.compile(schemas.benchmarkPreset),
  harborJobConfig: ajv.compile(schemas.harborJobConfig),
  strictHarborJobConfig: strictAjv.compile(
    closeSchemaObjects(schemas.harborJobConfig) as typeof schemas.harborJobConfig,
  ),
  runRecord: ajv.compile(schemas.runRecord),
  runState: ajv.compile(schemas.runState),
} as const;

export class ContractValidationError extends Error {
  readonly errors: readonly ErrorObject[];

  constructor(label: string, errors: readonly ErrorObject[]) {
    super(`${label} failed schema validation`);
    this.name = "ContractValidationError";
    this.errors = errors;
  }
}

function validate<T>(validator: ValidateFunction, value: unknown, label: string): T {
  if (!validator(value))
    throw new ContractValidationError(label, validator.errors ?? []);
  return value as T;
}

export const validateAgentPreset = (value: unknown): AgentPresetV1 =>
  validate(validators.agentPreset, value, "agent preset");
export const validateAgentWorkbenchRecipe = <T extends AgentWorkbenchRecipeV1>(
  value: unknown,
): T => validate(validators.agentWorkbenchRecipe, value, "agent workbench recipe") as T;
export const validateAttemptCost = (value: unknown): AttemptCostV1 =>
  validate(validators.attemptCost, value, "attempt cost receipt");
export const validateBenchmarkPreset = (value: unknown): BenchmarkPresetV1 =>
  validate(validators.benchmarkPreset, value, "benchmark preset");
export const validateHarborJobConfig = (value: unknown): HarborJobConfigV1 =>
  validate(validators.harborJobConfig, value, "Harbor JobConfig");
export const validateStrictHarborJobConfig = (value: unknown): HarborJobConfigV1 =>
  validate(validators.strictHarborJobConfig, value, "strict Harbor JobConfig");
export const validateRunRecord = (value: unknown): RunRecordV1 =>
  validate(validators.runRecord, value, "run record");
export const validateRunState = (value: unknown): RunStateV1 =>
  validate(validators.runState, value, "run state");

export const validateSavedWorkbench = (value: unknown): SavedWorkbenchConfigurationV1 =>
  validate(validators.savedWorkbench, value, "saved configuration");
