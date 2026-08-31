import { describe, expect, it } from "vitest";
import { profile } from "@harbor-hf/test-fixtures";
import { ProfileResolver } from "../src/profiles.js";

describe("ProfileResolver", () => {
  it("resolves bounded checked-in compatibility aliases to one profile", () => {
    const reusable = profile("harness", "pi-off", {
      contract_version: "v1",
      agent: "pi",
      revision: "1.0.0",
      required_evidence: [],
      capabilities: { inference_apis: ["chat-completions"] },
      aliases: ["pi"],
    });
    const resolver = new ProfileResolver([reusable]);
    expect(resolver.get("harness", "pi").profile_id).toBe(reusable.profile_id);
    expect(resolver.get("harness", "pi-off").profile_id).toBe(reusable.profile_id);
  });

  it("selects only deployments with a native model and harness API", () => {
    const model = profile("model", "model", {
      contract_version: "v1",
      model_id: "example/model",
      revision: "a",
      harbor_model_name: "openai/example/model:provider",
      compatibility: {
        reasoning: false,
        inference_apis: ["chat-completions"],
      },
    });
    const harness = profile("harness", "harness", {
      contract_version: "v1",
      agent: "agent",
      revision: "1.0.0",
      required_evidence: [],
      capabilities: { inference_apis: ["chat-completions"] },
    });
    const deployment = (name: string, api: "chat-completions" | "responses") =>
      profile("deployment", name, {
        contract_version: "v1",
        route: "hf_job",
        models: ["model"],
        harnesses: ["harness"],
        inference_token: "required",
        inference_api: api,
      });
    const supported = deployment("supported", "chat-completions");
    const unsupported = deployment("unsupported", "responses");

    const resolver = new ProfileResolver([model, harness, supported, unsupported]);
    expect(resolver.selectDeployment("model", "harness").profile_id).toBe(
      supported.profile_id,
    );

    const unsupportedOnly = new ProfileResolver([model, harness, unsupported]);
    expect(() => unsupportedOnly.selectDeployment("model", "harness")).toThrow(
      "found 0",
    );
  });

  it("keeps the deployed profile when a promotion is a stale digest of the same name", () => {
    const current = profile("deployment", "tb21-providers", {
      contract_version: "v1",
      route: "hf_job",
      worker_revision: "current-revision",
    });
    const stale = profile("deployment", "tb21-providers", {
      contract_version: "v1",
      route: "hf_job",
      worker_revision: "stale-revision",
    });
    const resolver = new ProfileResolver([current]);
    resolver.replacePromotedProfiles([{ ...stale, alias: "tb21-providers" }]);
    expect(resolver.get("deployment", "tb21-providers").profile_id).toBe(
      current.profile_id,
    );
    expect(resolver.get("deployment", "tb21-providers").profile.spec).toMatchObject({
      worker_revision: "current-revision",
    });
  });

  it("keeps a promotion that remaps a checked-in name to a different profile", () => {
    const builtIn = profile("model", "control-smoke", {
      contract_version: "v1",
      model_id: "built-in",
      revision: "a",
      harbor_model_name: "openai/example/built-in:provider",
      compatibility: {
        reasoning: false,
        inference_apis: ["chat-completions"],
      },
    });
    const remapped = profile("model", "durable-model", {
      contract_version: "v1",
      model_id: "durable",
      revision: "b",
      harbor_model_name: "openai/example/durable:provider",
      compatibility: {
        reasoning: false,
        inference_apis: ["chat-completions"],
      },
    });
    const resolver = new ProfileResolver([builtIn]);
    resolver.replacePromotedProfiles([{ ...remapped, alias: "control-smoke" }]);
    expect(resolver.get("model", "control-smoke").profile_id).toBe(remapped.profile_id);
  });

  it("keeps a promotion that only exists as an extra alias", () => {
    const builtIn = profile("harness", "opencode", {
      contract_version: "v1",
      agent: "opencode",
      revision: "1.0.0",
      required_evidence: [],
      capabilities: { inference_apis: ["chat-completions"] },
    });
    const extra = profile("harness", "opencode-canary", {
      contract_version: "v1",
      agent: "opencode",
      revision: "1.0.0",
      required_evidence: [],
      capabilities: { inference_apis: ["chat-completions"] },
    });
    const resolver = new ProfileResolver([builtIn]);
    resolver.replacePromotedProfiles([{ ...extra, alias: "opencode-canary" }]);
    expect(resolver.get("harness", "opencode").profile_id).toBe(builtIn.profile_id);
    expect(resolver.get("harness", "opencode-canary").profile_id).toBe(
      extra.profile_id,
    );
  });
});
