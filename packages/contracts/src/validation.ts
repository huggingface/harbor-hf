import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type {
  InferenceRegistrationRequestV1,
  InferenceStatusRequestV1,
  InferenceReviewRequestV1,
  InferenceApprovalRequestV1,
  InferenceReviewV1,
  InferenceSourceRegistryV1,
  InferenceBindingManifestV1,
  InferenceBindingsV1,
  RunPricingCorrectionsV1,
  PricingCorrectionRequestV1,
  LaunchPricingV1,
  AgentPresetV1,
  AgentWorkbenchRecipeV1,
  AttemptCostV1,
  BenchmarkPresetV1,
  HarborJobConfigV1,
  RunRecordV1,
  RunStateV1,
  RunPresentationV1,
  TrialProgressV1,
} from "./generated/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");

function load(name: string): object {
  return JSON.parse(readFileSync(join(root, name), "utf8")) as object;
}

export const schemas = {
  inferenceReview: load("inference-review-v1.schema.json"),
  inferenceApprovalRequest: load("inference-approval-request-v1.schema.json"),
  inferenceReviewRequest: load("inference-review-request-v1.schema.json"),
  inferenceStatusRequest: load("inference-status-request-v1.schema.json"),
  inferenceRegistrationRequest: load("inference-registration-request-v1.schema.json"),
  inferenceSourceRegistry: load("inference-source-registry-v1.schema.json"),
  inferenceBindingManifest: load("inference-binding-manifest-v1.schema.json"),
  inferenceBindings: load("inference-bindings-v1.schema.json"),
  runPricingCorrections: load("run-pricing-corrections-v1.schema.json"),
  pricingCorrectionRequest: load("pricing-correction-request-v1.schema.json"),
  launchPricing: load("launch-pricing-v1.schema.json"),
  sharedEstimate: load("shared-estimate-v1.schema.json"),
  leaderboardRow: load("leaderboard-row-v1.schema.json"),
  agentPreset: load("agent-preset-v1.schema.json"),
  agentWorkbenchRecipe: load("agent-workbench-v1.schema.json"),
  attemptCost: load("attempt-cost-v1.schema.json"),
  benchmarkPreset: load("benchmark-preset-v1.schema.json"),
  harborJobConfig: load("harbor-job-config-v1.schema.json"),
  runRecord: load("run-record-v1.schema.json"),
  agentTiming: load("agent-timing-v1.schema.json"),
  trialProgress: load("trial-progress-v1.schema.json"),
  runPresentation: load("run-presentation-v1.schema.json"),
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
ajv.addSchema(schemas.launchPricing);
ajv.addSchema(
  schemas.agentWorkbenchRecipe,
  "https://harborframework.com/schemas/harbor-hf/agent-workbench-v1.schema.json",
);
const validators = {
  inferenceReview: ajv.compile(schemas.inferenceReview),
  inferenceApprovalRequest: ajv.compile(schemas.inferenceApprovalRequest),
  inferenceReviewRequest: ajv.compile(schemas.inferenceReviewRequest),
  inferenceStatusRequest: ajv.compile(schemas.inferenceStatusRequest),
  inferenceRegistrationRequest: ajv.compile(schemas.inferenceRegistrationRequest),
  inferenceSourceRegistry: ajv.compile(schemas.inferenceSourceRegistry),
  inferenceBindingManifest: ajv.compile(schemas.inferenceBindingManifest),
  inferenceBindings: ajv.compile(schemas.inferenceBindings),
  runPricingCorrections: ajv.compile(schemas.runPricingCorrections),
  pricingCorrectionRequest: ajv.compile(schemas.pricingCorrectionRequest),
  launchPricing: ajv.getSchema(
    "https://harbor-hf.example/schemas/launch-pricing-v1.schema.json",
  )!,
  agentPreset: ajv.compile(schemas.agentPreset),
  agentWorkbenchRecipe: ajv.compile(schemas.agentWorkbenchRecipe),
  attemptCost: ajv.compile(schemas.attemptCost),
  benchmarkPreset: ajv.compile(schemas.benchmarkPreset),
  harborJobConfig: ajv.compile(schemas.harborJobConfig),
  strictHarborJobConfig: strictAjv.compile(
    closeSchemaObjects(schemas.harborJobConfig) as typeof schemas.harborJobConfig,
  ),
  runRecord: ajv.compile(schemas.runRecord),
  runPresentation: ajv.compile(schemas.runPresentation),
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

export function validateRunPricingCorrections(value: unknown): RunPricingCorrectionsV1 {
  const history = validate<RunPricingCorrectionsV1>(
    validators.runPricingCorrections,
    value,
    "pricing corrections",
  );
  if (history.revisions.some((entry, index) => entry.revision !== index + 1))
    throw new Error("pricing correction revision chain is invalid");
  return history;
}
export const validatePricingCorrectionRequest = (
  value: unknown,
): PricingCorrectionRequestV1 =>
  validate(validators.pricingCorrectionRequest, value, "pricing correction request");
export const validateLaunchPricing = (value: unknown): LaunchPricingV1 =>
  validate(validators.launchPricing, value, "launch pricing");
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
export const validateRunPresentation = (value: unknown): RunPresentationV1 =>
  validate(validators.runPresentation, value, "run presentation");
export const validateRunState = (value: unknown): RunStateV1 =>
  validate(validators.runState, value, "run state");

// Artifact payloads are allowlisted projections, not native durable records.
// Strip unknown native fields before returning observations to the browser.
const observationAjv = new Ajv2020({ strict: false, removeAdditional: true });
observationAjv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => Number.isFinite(Date.parse(value)),
});
const progressValidator = observationAjv.compile(schemas.trialProgress);
export const validateTrialProgress = (value: unknown): TrialProgressV1 =>
  validate(progressValidator, structuredClone(value), "trial progress");

export const validateInferenceBindingManifest = (
  value: unknown,
): InferenceBindingManifestV1 =>
  validate(validators.inferenceBindingManifest, value, "inference binding manifest");
export const validateInferenceBindings = (value: unknown): InferenceBindingsV1 =>
  validate(validators.inferenceBindings, value, "inference bindings");

export const validateInferenceSourceRegistry = (
  value: unknown,
): InferenceSourceRegistryV1 =>
  validate(validators.inferenceSourceRegistry, value, "inference source registry");

export const validateInferenceRegistrationRequest = (
  value: unknown,
): InferenceRegistrationRequestV1 =>
  validate(validators.inferenceRegistrationRequest, value, "inference request");

export const validateInferenceStatusRequest = (
  value: unknown,
): InferenceStatusRequestV1 =>
  validate(validators.inferenceStatusRequest, value, "inference request");

export const validateInferenceReviewRequest = (
  value: unknown,
): InferenceReviewRequestV1 =>
  validate(validators.inferenceReviewRequest, value, "inference request");

export const validateInferenceApprovalRequest = (
  value: unknown,
): InferenceApprovalRequestV1 =>
  validate(validators.inferenceApprovalRequest, value, "inference request");

export const validateInferenceReview = (value: unknown): InferenceReviewV1 =>
  validate(validators.inferenceReview, value, "inference request");
