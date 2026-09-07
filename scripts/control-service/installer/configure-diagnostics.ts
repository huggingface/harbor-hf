import { HfCommandFailure } from "./hf.js";
import { ProcessFailure } from "./process.js";

export type ConfigureOperation =
  | "stage_bundle"
  | "assert_entry"
  | "pause"
  | "set_protected"
  | "observe_protected"
  | "assert_protected"
  | "upload"
  | "observe_upload"
  | "assert_upload"
  | "observe_paused"
  | "assert_paused"
  | "persist_receipt"
  | "stage_credentials"
  | "write_variables"
  | "set_variables"
  | "observe_configured"
  | "assert_configured"
  | "restart"
  | "wait_runtime"
  | "verify";

const VALIDATION_CATEGORIES = new Map([
  ["namespace listings are incomplete", "namespace_listing_incomplete"],
  [
    "existing Space settings do not match the installer contract",
    "space_contract_mismatch",
  ],
  ["existing Space is not installer-marked", "installer_marker_mismatch"],
  ["existing Space variables do not match", "variables_mismatch"],
  ["existing Space source revision is invalid", "source_revision_invalid"],
  ["existing Space bundle manifest digest is invalid", "manifest_digest_invalid"],
  ["existing Space has extra secrets", "unexpected_secret_names"],
  ["Space secret names do not match", "secret_names_mismatch"],
  ["Space runtime is not RUNNING", "runtime_not_running"],
  ["existing Bucket does not match the installer contract", "bucket_contract_mismatch"],
  ["configured Space metadata is unavailable", "space_metadata_missing"],
  ["configured Space upload revision does not match", "upload_revision_mismatch"],
  ["unexpected Hugging Face mutation JSON", "mutation_response_invalid"],
  ["Hugging Face mutation returned a different target", "mutation_target_mismatch"],
  ["Hugging Face mutation was not successful", "mutation_unsuccessful"],
]);
const PROCESS_CATEGORIES = new Set([
  "launch",
  "timeout",
  "stdout_limit",
  "stderr_limit",
  "nonzero",
  "malformed_json",
]);
const PROVIDER_CATEGORIES = new Set([
  "unauthorized",
  "forbidden",
  "conflict",
  "rate_limited",
  "client_error",
  "server_error",
  "quota_or_limit",
  "runtime_stage_missing",
  "json_decode",
  "cli_validation",
  "transport",
  "cli_argument",
]);

// Exact closed labels only: never interpolate messages, causes, output or URLs.
// Runtime membership checks also reject forged typed error fields.
export function configureFailureCategory(error: unknown): string {
  if (error instanceof HfCommandFailure && PROVIDER_CATEGORIES.has(error.category)) {
    return `provider_${error.category}`;
  }
  if (error instanceof ProcessFailure && PROCESS_CATEGORIES.has(error.reason)) {
    return `process_${error.reason}`;
  }
  return error instanceof Error
    ? (VALIDATION_CATEGORIES.get(error.message) ?? "unclassified")
    : "unclassified";
}

export class ConfigureDiagnostics {
  operation: ConfigureOperation = "stage_bundle";

  suffix(error: unknown): string {
    return `; operation: ${this.operation}; failure category: ${configureFailureCategory(error)}`;
  }
}
