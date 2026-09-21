import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateHarborJobConfig } from "@harbor-hf/contracts";
import {
  InferenceBindings,
  presetModelId,
  presetSubject,
} from "../src/inference-bindings.js";
import { PresetCatalog, presetEndpointAgent } from "../src/presets.js";
import { actor, image } from "./inference-fixture.js";

const catalog = await PresetCatalog.load(
  fileURLToPath(new URL("../../../presets", import.meta.url)),
);
const identity = {
  import_path: "harbor_hf_agents.pi.agent:PiAgent",
  version: "0.84.4",
};
const modelId = "example/model";
const baseUrl = "https://example-endpoint.invalid/v1";
const ref = "INFERENCE_API_KEY_EXAMPLE";
const source = "EXAMPLE_ROUTE_KEY";
const submission = {
  benchmark: { name: "terminal-bench-2-1", preset: "all-tasks-1-trial-qemu-fixed" },
  model: { id: modelId, provider: "endpoint", reasoning_effort: "medium" },
  harness: { agent: "pi", version: "0.84.4" },
  cost_ceiling_usd: 1,
};
function grantOf(overrides: Record<string, unknown> = {}) {
  return {
    operator_subjects: [actor],
    worker_image: image,
    agent_import_path: identity.import_path,
    agent_version: identity.version,
    destination_env: ["OPENAI_API_KEY"],
    route_api: "chat-completions",
    base_url: baseUrl,
    allowed_hosts: ["example-endpoint.invalid"],
    allowed_models: [modelId],
    ...overrides,
  };
}
function policyOf(uses: Record<string, unknown>[]) {
  return new InferenceBindings({
    schema_version: "v1",
    bindings: [
      { ref, source_env: source, label: "Example route", enabled: true, uses },
    ],
  });
}
function connection() {
  return {
    ref,
    source,
    base_url: baseUrl,
    allowed_hosts: ["example-endpoint.invalid"],
  };
}
function presetAgent(reasoning = "default") {
  return presetEndpointAgent(
    undefined,
    catalog.agent("pi", "0.84.4"),
    modelId,
    { ...connection(), route_api: "chat-completions" },
    reasoning,
  );
}
function admit(agent: Record<string, unknown>, uses = [grantOf()]) {
  return policyOf(uses).selected(
    validateHarborJobConfig({ agents: [agent] }),
    actor,
    image,
  );
}

describe("reviewed endpoint connections for native presets", () => {
  it("selects the reviewed connection only for the exact preset subject", () => {
    const policy = policyOf([grantOf()]);
    const selected = policy.presetConnection(identity, modelId, actor, image);
    expect(selected).toMatchObject({ ref, source, base_url: baseUrl });
    expect(selected?.route_api).toBe("chat-completions");
    expect(policy.presetConnection(identity, "example/other", actor, image)).toBeNull();
    expect(
      policy.presetConnection({ ...identity, version: "0.0.1" }, modelId, actor, image),
    ).toBeNull();
    expect(
      policy.presetConnection(identity, modelId, "other-operator", image),
    ).toBeNull();
    expect(
      policy.presetConnection(
        identity,
        modelId,
        actor,
        "example.invalid/other@sha256:0",
      ),
    ).toBeNull();
    expect(
      policyOf([
        grantOf({ agent_version: undefined, recipe_digest: "a".repeat(64) }),
      ]).presetConnection(identity, modelId, actor, image),
    ).toBeNull();
  });

  it("builds the reviewed record and admits it through the same check", () => {
    const built = presetEndpointAgent(
      undefined,
      catalog.agent("pi", "0.84.4"),
      modelId,
      { ...connection(), route_api: "responses" },
      "high",
    );
    expect(built.model_name).toBe(`openai/${modelId}`);
    expect(built.env).toEqual({
      OPENAI_BASE_URL: baseUrl,
      OPENAI_API_KEY: `\${${ref}}`,
    });
    expect(built.extra_allowed_hosts).toEqual(["example-endpoint.invalid"]);
    expect(built.kwargs).toEqual({
      version: "0.84.4",
      thinking: "high",
      model_api: "openai-responses",
    });
    expect(built.name).toBeUndefined();
    const agent = presetAgent("medium");
    expect(agent.kwargs).toEqual({
      version: "0.84.4",
      thinking: "medium",
      model_api: "openai-completions",
    });
    expect(admit(agent)?.ref).toBe(ref);
    expect(admit(agent)?.source).toBe(source);
  });

  it("keeps the default router record for the same preset without a connection", () => {
    const router = catalog.buildJobConfig("run-1", submission, "/data");
    expect(router.agents?.[0]?.model_name).toBe("huggingface/example/model:endpoint");
    expect(router.agents?.[0]?.env).toEqual({ HF_TOKEN: "${HF_INFERENCE_TOKEN}" });
    expect(router.agents?.[0]?.kwargs).toEqual({
      version: "0.84.4",
      thinking: "medium",
    });
    expect(policyOf([grantOf()]).selected(router, actor, image)).toBeNull();
  });

  it("builds the endpoint record through the catalog and admits it", () => {
    const endpoint = catalog.buildJobConfig("run-2", submission, "/data", {
      ...connection(),
      route_api: "chat-completions",
    });
    const agent = endpoint.agents?.[0];
    expect(agent?.model_name).toBe(`openai/${modelId}`);
    expect(agent?.env).toEqual({
      OPENAI_BASE_URL: baseUrl,
      OPENAI_API_KEY: `\${${ref}}`,
    });
    expect(agent?.extra_allowed_hosts).toEqual(["example-endpoint.invalid"]);
    expect(policyOf([grantOf()]).selected(endpoint, actor, image)?.ref).toBe(ref);
    expect(presetSubject(agent as Record<string, unknown>)).toEqual(identity);
    expect(presetModelId(agent?.model_name)).toBe(modelId);
    expect(presetModelId("huggingface/example/model:provider")).toBeNull();
    expect(presetSubject({ import_path: identity.import_path })).toBeNull();
  });

  it("denies a record whose environment, hosts or model differ from the grant", () => {
    const agent = presetAgent();
    const changed = (patch: Record<string, unknown>) => ({
      ...agent,
      ...patch,
    });
    expect(() =>
      admit(
        changed({
          env: {
            ...(agent.env as object),
            OPENAI_BASE_URL: "https://other.invalid/v1",
          },
        }),
      ),
    ).toThrow("not reviewed");
    expect(() => admit(changed({ extra_allowed_hosts: ["other.invalid"] }))).toThrow(
      "not reviewed",
    );
    expect(() => admit(changed({ extra_allowed_hosts: [] }))).toThrow("not reviewed");
    expect(() => admit(changed({ model_name: "openai/example/other" }))).toThrow(
      "not reviewed",
    );
    expect(() => admit(changed({ model_name: `huggingface/${modelId}` }))).toThrow(
      "not reviewed",
    );
    expect(() =>
      admit(changed({ kwargs: { ...(agent.kwargs as object), version: "0.0.1" } })),
    ).toThrow("not reviewed");
    expect(() =>
      admit(
        changed({
          env: { ...(agent.env as object), OPENAI_API_KEY: "${HF_INFERENCE_TOKEN}" },
        }),
      ),
    ).toThrow("not reviewed");
    expect(() => admit(changed({ import_path: "other.module:Agent" }))).toThrow(
      "not reviewed",
    );
    expect(() => admit(agent, [])).toThrow("not reviewed");
    expect(() =>
      admit(agent, [grantOf({ operator_subjects: ["other-operator"] })]),
    ).toThrow("not reviewed");
    expect(() =>
      admit(agent, [
        grantOf({ worker_image: `example.invalid/other@sha256:${"b".repeat(64)}` }),
      ]),
    ).toThrow("not reviewed");
    expect(() =>
      admit(agent, [
        grantOf({
          base_url: "https://other.invalid/v1",
          allowed_hosts: ["other.invalid"],
        }),
      ]),
    ).toThrow("not reviewed");
    expect(() =>
      admit(
        changed({
          env: { OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: `\${${ref}}`, LANG: "C" },
        }),
      ),
    ).toThrow("not reviewed");
  });

  it("denies a submission whose preset subject is ambiguous", () => {
    const policy = new InferenceBindings({
      schema_version: "v1",
      bindings: [
        { ref, source_env: source, label: "First", enabled: true, uses: [grantOf()] },
        {
          ref: "INFERENCE_API_KEY_ALT",
          source_env: "ALT_ROUTE_KEY",
          label: "Second",
          enabled: true,
          uses: [
            grantOf({
              route_api: "responses",
              base_url: "https://alt-endpoint.invalid/v1",
              allowed_hosts: ["alt-endpoint.invalid"],
            }),
          ],
        },
      ],
    });
    expect(() => policy.presetConnection(identity, modelId, actor, image)).toThrow(
      "not reviewed",
    );
  });

  it("rejects a grant that names two subject kinds, none, or a preset without a route", () => {
    const cases: Record<string, unknown>[] = [
      grantOf({ recipe_digest: "b".repeat(64) }),
      grantOf({ agent_version: undefined }),
      grantOf({ base_url: null }),
      grantOf({ destination_env: ["MODEL_KEY"] }),
      grantOf({ destination_env: [] }),
      grantOf({ agent_version: "" }),
    ];
    for (const use of cases)
      expect(() => policyOf([use])).toThrow("Invalid inference binding manifest");
    expect(() =>
      policyOf([grantOf({ base_url: "http://example.invalid/v1" })]),
    ).toThrow("Invalid inference binding manifest");
    expect(() => policyOf([grantOf({ allowed_hosts: [], base_url: baseUrl })])).toThrow(
      "Invalid inference binding manifest",
    );
  });

  it("keeps the account-token denial for a non-router URL", () => {
    const agent = presetAgent();
    const token = {
      model_name: `openai/${modelId}`,
      env: { OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: "${HF_INFERENCE_TOKEN}" },
    };
    expect(() => admit(token)).toThrow("not reviewed");
    expect(() =>
      new InferenceBindings().selected(
        validateHarborJobConfig({
          agents: [
            {
              model_name: `openai/${modelId}`,
              env: {
                OPENAI_BASE_URL: baseUrl,
                OPENAI_API_KEY: "${HF_INFERENCE_TOKEN}",
              },
            },
          ],
        }),
        actor,
        image,
      ),
    ).toThrow("not reviewed");
    expect(agent.env).toBeDefined();
  });

  it("refuses a preset that declares no endpoint API style or version identity", () => {
    const preset = {
      ...catalog.agent("pi", "0.84.4"),
      endpoint_api: undefined,
    };
    expect(() =>
      presetEndpointAgent(
        undefined,
        preset,
        modelId,
        {
          ...connection(),
          route_api: "chat-completions",
        },
        "default",
      ),
    ).toThrow("cannot use a reviewed endpoint connection");
    expect(() =>
      presetEndpointAgent(
        undefined,
        {
          ...catalog.agent("pi", "0.84.4"),
          harbor_agent: { import_path: identity.import_path, kwargs: {} },
        },
        modelId,
        { ...connection(), route_api: "chat-completions" },
        "default",
      ),
    ).toThrow("cannot use a reviewed endpoint connection");
    expect(() =>
      presetEndpointAgent(
        undefined,
        catalog.agent("pi", "0.84.4"),
        modelId,
        {
          ...connection(),
          route_api: "native",
        },
        "default",
      ),
    ).toThrow("cannot use a reviewed endpoint connection");
  });
});
