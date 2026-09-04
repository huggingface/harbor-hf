import { describe, expect, it } from "vitest";
import { configureFailureCategory } from "../configure-diagnostics.js";
import { HfCommandFailure } from "../hf.js";
import { ProcessFailure } from "../process.js";

describe("closed configure failure categories", () => {
  it.each([
    [new ProcessFailure("malformed_json"), "process_malformed_json"],
    [new ProcessFailure("nonzero"), "process_nonzero"],
    [new ProcessFailure("timeout"), "process_timeout"],
    [new HfCommandFailure("forbidden"), "provider_forbidden"],
    [new Error("unexpected Hugging Face mutation JSON"), "mutation_response_invalid"],
    [new Error("existing Space variables do not match"), "variables_mismatch"],
    [
      new Error("existing Space settings do not match the installer contract"),
      "space_contract_mismatch",
    ],
  ])("classifies only deterministic labels", (error, expected) => {
    expect(configureFailureCategory(error)).toBe(expected);
  });

  it.each([
    "runtime_stage_missing",
    "json_decode",
    "cli_validation",
    "transport",
    "cli_argument",
  ] as const)("propagates only the closed %s label", (category) => {
    expect(configureFailureCategory(new HfCommandFailure(category))).toBe(
      `provider_${category}`,
    );
    const forged = new HfCommandFailure(category);
    Object.defineProperty(forged, "category", {
      value: `${category} https://example.invalid/?token=credential-placeholder`,
    });
    expect(configureFailureCategory(forged)).toBe("unclassified");
  });

  it("does not leak arbitrary messages, causes, provider fields, or forged types", () => {
    const privateText = "https://example.invalid/private?token=credential-placeholder";
    const forgedProcess = new ProcessFailure("nonzero");
    Object.defineProperty(forgedProcess, "reason", { value: privateText });
    const forgedProvider = new HfCommandFailure("forbidden");
    Object.defineProperty(forgedProvider, "category", { value: privateText });
    for (const error of [
      privateText,
      { message: privateText, reason: "timeout", category: "forbidden" },
      new Error(privateText, { cause: new Error(privateText) }),
      new Error(`existing Space variables do not match ${privateText}`),
      forgedProcess,
      forgedProvider,
    ]) {
      expect(configureFailureCategory(error)).toBe("unclassified");
    }
  });
});
