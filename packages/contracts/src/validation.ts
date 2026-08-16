import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");

function load(name: string): object {
  return JSON.parse(readFileSync(join(root, name), "utf8")) as object;
}

export const schemas = {
  apiError: load("api-error-v1.schema.json"),
  attemptSubmission: load("attempt-submission-v1.schema.json"),
  campaignAction: load("campaign-action-v1.schema.json"),
  campaignSubmission: load("campaign-submission-v1.schema.json"),
  controlRecord: load("control-record-v1.schema.json"),
  resultCatalog: load("result-catalog-v1.schema.json"),
  workerEvidenceManifest: load("worker-evidence-manifest-v1.schema.json"),
} as const;

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => Number.isFinite(Date.parse(value)),
});

const validators = {
  attemptSubmission: ajv.compile(schemas.attemptSubmission),
  campaignAction: ajv.compile(schemas.campaignAction),
  campaignSubmission: ajv.compile(schemas.campaignSubmission),
  controlRecord: ajv.compile(schemas.controlRecord),
  resultCatalog: ajv.compile(schemas.resultCatalog),
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

export function validateControlRecord<T>(value: unknown): T {
  return validate<T>(validators.controlRecord, value, "control record");
}

export function validateCampaignSubmission<T>(value: unknown): T {
  return validate<T>(validators.campaignSubmission, value, "campaign submission");
}

export function validateCampaignAction<T>(value: unknown): T {
  return validate<T>(validators.campaignAction, value, "campaign action");
}

export function validateResultCatalog<T>(value: unknown): T {
  return validate<T>(validators.resultCatalog, value, "result catalog");
}

export function validateWorkerEvidenceManifest<T>(value: unknown): T {
  return validate<T>(
    validators.workerEvidenceManifest,
    value,
    "worker evidence manifest",
  );
}
