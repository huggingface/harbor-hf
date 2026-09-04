import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");

function load(name: string): object {
  return JSON.parse(readFileSync(join(root, name), "utf8")) as object;
}

export const schemas = {
  leaderboardSubmission: load("leaderboard-submission-v1.schema.json"),
  leaderboardDecision: load("leaderboard-decision-v1.schema.json"),
  benchmarkCatalog: load("benchmark-catalog-v1.schema.json"),
  savedWorkbench: load("saved-workbench-v1.schema.json"),
  apiError: load("api-error-v1.schema.json"),
  agentWorkbench: load("agent-workbench-v1.schema.json"),
  attemptSubmission: load("attempt-submission-v1.schema.json"),
  runAction: load("run-action-v1.schema.json"),
  runContinuation: load("run-continuation-v1.schema.json"),
  runSubmission: load("run-submission-v1.schema.json"),
  controlRecord: load("control-record-v1.schema.json"),
  preparedJobSubmission: load("prepared-job-submission-v1.schema.json"),
  resultCatalog: load("result-catalog-v1.schema.json"),
  leaderboardSnapshot: load("leaderboard-snapshot-v1.schema.json"),
  workerEvidenceManifest: load("worker-evidence-manifest-v1.schema.json"),
} as const;

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => Number.isFinite(Date.parse(value)),
});
ajv.addKeyword({ keyword: "tsType", valid: true });
ajv.addSchema(schemas.agentWorkbench);

const validators = {
  leaderboardSubmission: ajv.compile(schemas.leaderboardSubmission),
  leaderboardDecision: ajv.compile(schemas.leaderboardDecision),
  benchmarkCatalog: ajv.compile(schemas.benchmarkCatalog),
  savedWorkbench: ajv.compile(schemas.savedWorkbench),
  agentWorkbench: ajv.compile(schemas.agentWorkbench),
  attemptSubmission: ajv.compile(schemas.attemptSubmission),
  runAction: ajv.compile(schemas.runAction),
  runContinuation: ajv.compile(schemas.runContinuation),
  runSubmission: ajv.compile(schemas.runSubmission),
  controlRecord: ajv.compile(schemas.controlRecord),
  preparedJobSubmission: ajv.compile(schemas.preparedJobSubmission),
  resultCatalog: ajv.compile(schemas.resultCatalog),
  leaderboardSnapshot: ajv.compile(schemas.leaderboardSnapshot),
  workerEvidenceManifest: ajv.compile(schemas.workerEvidenceManifest),
} as const;

export class ContractValidationError extends Error {
  readonly errors: readonly ErrorObject[];

  constructor(message: string, errors: readonly ErrorObject[]) {
    super(message);
    this.name = "ContractValidationError";
    this.errors = errors;
  }
}

function validate<T>(validator: ValidateFunction, value: unknown, label: string): T {
  if (!validator(value)) {
    throw new ContractValidationError(`${label} is invalid`, validator.errors ?? []);
  }
  return value as T;
}

export function validateAttemptSubmission<T>(value: unknown): T {
  return validate<T>(validators.attemptSubmission, value, "attempt submission");
}

export function validateAgentWorkbenchRecipe<T>(value: unknown): T {
  return validate<T>(validators.agentWorkbench, value, "agent workbench recipe");
}

export function validateControlRecord<T>(value: unknown): T {
  return validate<T>(validators.controlRecord, value, "control record");
}

export function validateRunSubmission<T>(value: unknown): T {
  return validate<T>(validators.runSubmission, value, "run submission");
}

export function validateRunContinuation<T>(value: unknown): T {
  return validate<T>(validators.runContinuation, value, "run continuation");
}

export function validateRunAction<T>(value: unknown): T {
  return validate<T>(validators.runAction, value, "run action");
}

export function validatePreparedJobSubmission<T>(value: unknown): T {
  return validate<T>(
    validators.preparedJobSubmission,
    value,
    "prepared job submission",
  );
}

export function validateResultCatalog<T>(value: unknown): T {
  return validate<T>(validators.resultCatalog, value, "result catalog");
}

export function validateLeaderboardSnapshot<T>(value: unknown): T {
  return validate<T>(validators.leaderboardSnapshot, value, "leaderboard snapshot");
}

export function validateWorkerEvidenceManifest<T>(value: unknown): T {
  return validate<T>(
    validators.workerEvidenceManifest,
    value,
    "worker evidence manifest",
  );
}

export function validateBenchmarkCatalog<T>(value: unknown): T {
  return validate<T>(validators.benchmarkCatalog, value, "benchmark catalog");
}

export function validateSavedWorkbench<T>(value: unknown): T {
  return validate<T>(validators.savedWorkbench, value, "saved workbench configuration");
}

export function validateLeaderboardSubmission<T>(value: unknown): T {
  return validate<T>(validators.leaderboardSubmission, value, "leaderboard submission");
}
export function validateLeaderboardDecision<T>(value: unknown): T {
  return validate<T>(validators.leaderboardDecision, value, "leaderboard decision");
}
