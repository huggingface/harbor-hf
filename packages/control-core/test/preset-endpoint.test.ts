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
const modelApi = "openai-completions";
const routerSubmission = {
  benchmark: { name: "terminal-bench-2-1", preset: "all-tasks-1-trial-qemu-fixed" },
  model: { id: modelId, provider: "endpoint", reasoning_effort: "medium" },
  harness: { agent: "pi", version: "0.84.4" },
  cost_ceiling_usd: 1,
};
/** The same run with the reviewed connection named instead of a Hub provider. */
const endpointSubmission = {
  ...routerSubmission,
  model: {
    id: modelId,
    connection: ref,
    model_api: modelApi,
    reasoning_effort: "medium",
  },
};
function grantOf(overrides: Record<string, unknown> = {}) {
  return {
    operator_subjects: [actor],
    worker_image: image,
    agent_import_path: identity.import_path,
    agent_version: identity.version,
    destination_env: ["OPENAI_API_KEY"],
    model_api: modelApi,
    base_url: baseUrl,
    allowed_hosts: ["example-endpoint.invalid"],
    allowed_models: [modelId],
    ...overrides,
  };
}
function recipeGrant() {
  return {
    operator_subjects: [actor],
    worker_image: image,
    agent_import_path: "recipes.agent:Agent",
    recipe_digest: "c".repeat(64),
    destination_env: ["EXAMPLE_ROUTE_KEY"],
    route_api: "chat-completions",
    base_url: baseUrl,
    allowed_hosts: ["example-endpoint.invalid"],
    allowed_models: [modelId],
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
function connection(overrides: Record<string, unknown> = {}) {
  return {
    ref,
    source,
    base_url: baseUrl,
    allowed_hosts: ["example-endpoint.invalid"],
    model_api: modelApi,
    ...overrides,
  };
}
function presetAgent(reasoning = "default") {
  return presetEndpointAgent(
    undefined,
    catalog.agent("pi", "0.84.4"),
    modelId,
    connection(),
    modelApi,
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
function select(policy: InferenceBindings, named = ref, api = modelApi) {
  return policy.presetConnection(named, identity, modelId, actor, image, api);
}

describe("reviewed endpoint connections for native presets", () => {
  it("resolves only the reviewed connection the submission names", () => {
    const policy = policyOf([grantOf()]);
    const selected = select(policy);
    expect(selected).toMatchObject({
      ref,
      source,
      base_url: baseUrl,
      model_api: modelApi,
    });
    // A grant never selects a route on its own: the name, the native wire API style,
    // the model, the actor, the image and the preset version must all agree.
    expect(select(policy, "INFERENCE_API_KEY_OTHER")).toBeNull();
    expect(select(policy, ref, "openai-responses")).toBeNull();
    expect(
      policy.presetConnection(ref, identity, "example/other", actor, image, modelApi),
    ).toBeNull();
    expect(
      policy.presetConnection(
        ref,
        { ...identity, version: "0.0.1" },
        modelId,
        actor,
        image,
        modelApi,
      ),
    ).toBeNull();
    expect(
      policy.presetConnection(
        ref,
        identity,
        modelId,
        "other-operator",
        image,
        modelApi,
      ),
    ).toBeNull();
    expect(
      policy.presetConnection(
        ref,
        identity,
        modelId,
        actor,
        "example.invalid/other@sha256:0",
        modelApi,
      ),
    ).toBeNull();
    expect(select(policyOf([recipeGrant()]))).toBeNull();
    expect(
      new InferenceBindings({
        schema_version: "v1",
        bindings: [
          {
            ref,
            source_env: source,
            label: "Disabled route",
            enabled: false,
            uses: [grantOf()],
          },
        ],
      }).presetConnection(ref, identity, modelId, actor, image, modelApi),
    ).toBeNull();
  });

  it("builds the native record the connection declares and admits it", () => {
    const built = presetEndpointAgent(
      undefined,
      catalog.agent("pi", "0.84.4"),
      modelId,
      connection({ model_api: "openai-responses" }),
      "openai-responses",
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
      model_api: modelApi,
    });
    expect(admit(agent)?.ref).toBe(ref);
    expect(admit(agent)?.source).toBe(source);
  });

  it("admits a pinned ACP source without adding an unsupported model_api option", () => {
    const acpPath = "harbor.agents.installed.acp:AcpAgent";
    const acpVersion = "1.2.3";
    const sourceConfig = {
      repo_url: "https://github.com/example/agent.git",
      ref: "a".repeat(40),
      source_dir: "agent",
      manifest_path: "harbor-agent.json",
    };
    const preset = {
      ...catalog.agent("pi", "0.84.4"),
      harbor_agent: {
        import_path: acpPath,
        kwargs: { version: acpVersion, source: sourceConfig },
      },
      reasoning_option: null,
    };
    const grant = grantOf({ agent_import_path: acpPath, agent_version: acpVersion });
    const policy = policyOf([grant]);
    const subject = { import_path: acpPath, version: acpVersion };
    expect(
      policy.presetConnection(ref, subject, modelId, actor, image, modelApi),
    ).toMatchObject(connection());
    expect(
      policy.presetConnection(ref, subject, modelId, actor, image, "openai-responses"),
    ).toBeNull();
    const agent = presetEndpointAgent(
      undefined,
      preset,
      modelId,
      connection(),
      modelApi,
      "default",
    );
    expect(agent.kwargs).toEqual({ version: acpVersion, source: sourceConfig });
    expect(admit(agent, [grant])).toEqual({ ref, source });
    expect(() => admit(agent, [grantOf({ ...grant, agent_version: "other" })])).toThrow(
      "not reviewed",
    );
    expect(() =>
      admit(
        { ...agent, kwargs: { ...(agent.kwargs as object), model_api: modelApi } },
        [grant],
      ),
    ).toThrow("not reviewed");
    expect(() =>
      admit(agent, [grant, grantOf({ ...grant, model_api: "openai-responses" })]),
    ).toThrow("not reviewed");
    expect(() =>
      admit(
        {
          ...agent,
          env: {
            OPENAI_BASE_URL: "https://other.invalid/v1",
            OPENAI_API_KEY: `\${${ref}}`,
          },
        },
        [grant],
      ),
    ).toThrow("not reviewed");
  });

  it("keeps the router record when the submission names no connection", () => {
    const router = catalog.buildJobConfig("run-1", routerSubmission, "/data");
    expect(router.agents?.[0]?.model_name).toBe("huggingface/example/model:endpoint");
    expect(router.agents?.[0]?.env).toEqual({ HF_TOKEN: "${HF_INFERENCE_TOKEN}" });
    expect(router.agents?.[0]?.kwargs).toEqual({
      version: "0.84.4",
      thinking: "medium",
    });
    expect(policyOf([grantOf()]).selected(router, actor, image)).toBeNull();
  });

  it("builds the endpoint record the submission named and admits it", () => {
    const endpoint = catalog.buildJobConfig(
      "run-2",
      endpointSubmission,
      "/data",
      connection(),
    );
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

  it("denies a record whose reviewed wire API style changed after the build", () => {
    const agent = presetAgent();
    expect(admit(agent)?.ref).toBe(ref);
    // The grant reviewed openai-completions, so another native value is not admitted.
    expect(() =>
      admit({
        ...agent,
        kwargs: { ...(agent.kwargs as object), model_api: "openai-responses" },
      }),
    ).toThrow("not reviewed");
    expect(() =>
      admit({
        ...agent,
        kwargs: { ...(agent.kwargs as object), model_api: "openai-completions-2" },
      }),
    ).toThrow("not reviewed");
    expect(() =>
      admit({
        ...agent,
        kwargs: { version: "0.84.4", thinking: "medium" },
      }),
    ).toThrow("not reviewed");
    expect(() => admit(agent, [grantOf({ model_api: "openai-responses" })])).toThrow(
      "not reviewed",
    );
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

  it("resolves exactly one connection when two reviewed uses share a subject", () => {
    const altRef = "INFERENCE_API_KEY_ALT";
    const altApi = "openai-responses";
    const policy = new InferenceBindings({
      schema_version: "v1",
      bindings: [
        { ref, source_env: source, label: "First", enabled: true, uses: [grantOf()] },
        {
          ref: altRef,
          source_env: "ALT_ROUTE_KEY",
          label: "Second",
          enabled: true,
          uses: [
            grantOf({
              model_api: altApi,
              base_url: "https://alt-endpoint.invalid/v1",
              allowed_hosts: ["alt-endpoint.invalid"],
            }),
          ],
        },
      ],
    });
    expect(select(policy)?.base_url).toBe(baseUrl);
    expect(select(policy, altRef, altApi)?.base_url).toBe(
      "https://alt-endpoint.invalid/v1",
    );
    // Two uses in one binding that both match the named configuration are a conflict
    // this submission flow must not resolve by itself.
    const duplicated = new InferenceBindings({
      schema_version: "v1",
      bindings: [
        {
          ref,
          source_env: source,
          label: "Duplicated",
          enabled: true,
          uses: [grantOf(), grantOf({ allowed_models: [modelId, "example/other"] })],
        },
      ],
    });
    expect(select(duplicated)).toBeNull();
  });

  it("rejects a grant that names two subject kinds, none, or the wrong wire API field", () => {
    const cases: Record<string, unknown>[] = [
      grantOf({ recipe_digest: "b".repeat(64) }),
      grantOf({ agent_version: undefined }),
      grantOf({ model_api: undefined }),
      grantOf({ route_api: "chat-completions" }),
      grantOf({ base_url: null }),
      grantOf({ destination_env: ["MODEL_KEY"] }),
      grantOf({ destination_env: [] }),
      grantOf({ agent_version: "" }),
      { ...recipeGrant(), model_api: modelApi },
      { ...recipeGrant(), route_api: undefined },
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

  it("refuses a preset without a version identity or a native wire API value", () => {
    expect(() =>
      presetEndpointAgent(
        undefined,
        {
          ...catalog.agent("pi", "0.84.4"),
          harbor_agent: { import_path: identity.import_path, kwargs: {} },
        },
        modelId,
        connection(),
        modelApi,
        "default",
      ),
    ).toThrow("cannot use a reviewed endpoint connection");
    expect(() =>
      presetEndpointAgent(
        undefined,
        catalog.agent("pi", "0.84.4"),
        modelId,
        connection({ model_api: "" }),
        "",
        "default",
      ),
    ).toThrow();
  });
});
