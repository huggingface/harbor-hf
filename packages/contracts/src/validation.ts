import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type {
  AgentPresetV1,
  BenchmarkPresetV1,
  HarborJobConfigV1,
  RunRecordV1,
  RunStateV1,
} from "./generated/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");

function load(name: string): object {
  return JSON.parse(readFileSync(join(root, name), "utf8")) as object;
}

export const schemas = {
  agentPreset: load("agent-preset-v1.schema.json"),
  benchmarkPreset: load("benchmark-preset-v1.schema.json"),
  harborJobConfig: load("harbor-job-config-v1.schema.json"),
  runRecord: load("run-record-v1.schema.json"),
  runState: load("run-state-v1.schema.json"),
} as const;

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: false });
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => Number.isFinite(Date.parse(value)),
});
ajv.addFormat("path", { type: "string", validate: () => true });
ajv.addFormat("uuid", {
  type: "string",
  validate: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ),
});

const validators = {
  agentPreset: ajv.compile(schemas.agentPreset),
  benchmarkPreset: ajv.compile(schemas.benchmarkPreset),
  harborJobConfig: ajv.compile(schemas.harborJobConfig),
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
export const validateBenchmarkPreset = (value: unknown): BenchmarkPresetV1 =>
  validate(validators.benchmarkPreset, value, "benchmark preset");
export const validateHarborJobConfig = (value: unknown): HarborJobConfigV1 =>
  validate(validators.harborJobConfig, value, "Harbor JobConfig");
export const validateRunRecord = (value: unknown): RunRecordV1 =>
  validate(validators.runRecord, value, "run record");
export const validateRunState = (value: unknown): RunStateV1 =>
  validate(validators.runState, value, "run state");
