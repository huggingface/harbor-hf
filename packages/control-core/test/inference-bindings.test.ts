import { describe, expect, it, vi } from "vitest";
import { containsCredentialMaterial } from "@harbor-hf/contracts/credentials";
import { InferenceBindings, inferenceRecipeDigest } from "../src/inference-bindings.js";
import {
  compileAgentWorkbenchRecipe,
  fastAgentWorkbenchStarter,
} from "../src/workbench.js";
import { nativeFastAgentStarter } from "../../../apps/control-web/src/native-starter.js";

import { actor, image, fixture } from "./inference-fixture.js";

describe("private reviewed inference references", () => {
  it.each(["EXAMPLE", "SECOND"])(
    "uses the identical native path for synthetic provider %s",
    (suffix) => {
      const { recipe, policy, compile, job } = fixture(suffix);
      const agent = compile();
      expect(agent.model_name).toBe(`${suffix.toLowerCase()}:unchanged/model`);
      expect(agent.env).toEqual({ OPENAI_API_KEY: `\${INFERENCE_API_KEY_${suffix}}` });
      expect(policy.selected(job(), actor, image)?.ref).toBe(
        `INFERENCE_API_KEY_${suffix}`,
      );
      expect(JSON.stringify(agent)).not.toContain("INFERENCE_SECRET_");
      expect(JSON.stringify(agent.kwargs)).not.toContain("credential_ref");
      expect(
        compileAgentWorkbenchRecipe(recipe).harbor_agent.kwargs.config.setup,
      ).toEqual({ script: "true", bindings: { MODEL: "model_name" }, literals: {} });
    },
  );
  it("is disabled by default and preserves exact HF output", () => {
    const policy = new InferenceBindings();
    expect(
      policy.discovery(actor, () => {
        throw Error("must not read");
      }),
    ).toEqual({ schema_version: "v1", revision: 0, bindings: [] });
    expect(
      policy.compile(fastAgentWorkbenchStarter, actor, image, undefined, () => false),
    ).toEqual(compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter).harbor_agent);
    expect(() =>
      policy.compile(fixture().recipe, actor, image, "native:model", () => true),
    ).toThrow("not reviewed");
  });
  it("scopes presence, not validity, and never exposes source identity or error details", () => {
    const { manifest } = fixture();
    const present = vi.fn(() => true);
    let policy = new InferenceBindings(manifest);
    expect(policy.discovery("other-operator", present).bindings).toEqual([]);
    expect(present).not.toHaveBeenCalled();
    expect(policy.discovery(actor, present).bindings[0]?.status).toBe("configured");
    expect(policy.discovery(actor, () => false).bindings[0]?.status).toBe("missing");
    expect(() =>
      policy.discovery(actor, () => {
        throw Error("private adapter detail");
      }),
    ).toThrow("presence is unavailable");
    expect(JSON.stringify(policy.discovery(actor, present))).not.toContain(
      "INFERENCE_SECRET_",
    );
    manifest.bindings[0]!.enabled = false;
    policy = new InferenceBindings(manifest);
    expect(
      policy.discovery(actor, () => {
        throw Error("must not read");
      }).bindings[0]?.status,
    ).toBe("disabled");
  });
  it.each([
    "HF_TOKEN",
    "HF_INFERENCE_TOKEN",
    "OAUTH_CLIENT_SECRET",
    "PATH",
    "HARBOR_HF_WORKER_CAPABILITY",
    "../key",
    "INFERENCE_SECRET_X:-default",
  ])("rejects authority or unsafe source %s", (name) => {
    const { manifest } = fixture();
    manifest.bindings[0]!.source_env = name;
    expect(() => new InferenceBindings(manifest)).toThrow(
      "Invalid inference binding manifest",
    );
  });
  it.each(["HF_TOKEN", "OAUTH_CLIENT_SECRET", "ENV", "HARBOR_HF_WORKER_CAPABILITY"])(
    "rejects authority destination %s",
    (name) => {
      const { manifest } = fixture();
      manifest.bindings[0]!.uses[0]!.destination_env = [name];
      expect(() => new InferenceBindings(manifest)).toThrow(
        "Invalid inference binding manifest",
      );
    },
  );
  it("checks exact immutable script, worker, actor, endpoint and current grant at restart", () => {
    const { policy, recipe, manifest, job } = fixture(
      "EXAMPLE",
      "https://inference.example.invalid/v1",
    );
    const config = job();
    expect(policy.selected(config, actor, image)).not.toBeNull();
    expect(() => policy.selected(config, "other-operator", image)).toThrow();
    expect(() => policy.selected(config, actor, `${image}x`)).toThrow();
    expect(() =>
      policy.compile(
        { ...recipe, run_command: "arbitrary command" },
        actor,
        image,
        "native:model",
        () => true,
      ),
    ).toThrow();
    config.agents![0]!.env!.OPENAI_BASE_URL = "https://other.example.invalid/v1";
    expect(() => policy.selected(config, actor, image)).toThrow();
    manifest.bindings[0]!.uses = [];
    expect(() =>
      new InferenceBindings(manifest).selected(job(), actor, image),
    ).toThrow();
    expect(() =>
      policy.compile(recipe, actor, image, "native:model", () => false),
    ).toThrow();
    expect(() => policy.compile(recipe, actor, image, undefined, () => true)).toThrow();
  });
  it.each([
    "HF_TOKEN",
    "${INFERENCE_API_KEY_EXAMPLE}",
    "INFERENCE_API_KEY_X:-default",
    "../key",
  ])("rejects malformed reference %s", (ref) => {
    const { recipe } = fixture();
    recipe.environment[0]!.credential_ref = ref;
    expect(() => compileAgentWorkbenchRecipe(recipe)).toThrow();
  });
  it("rejects literals, other binding sources, mixed references, unknown fields and unsafe paths", () => {
    for (const mutation of [
      { value: "synthetic-not-a-key" },
      { source: "literal", value: "text" },
      { source: "model_base_url" },
      { unexpected: true },
    ]) {
      const { recipe } = fixture();
      Object.assign(recipe.environment[0]!, mutation);
      expect(() => compileAgentWorkbenchRecipe(recipe)).toThrow();
    }
    const { recipe } = fixture();
    recipe.environment.push({
      name: "SECOND_API_KEY",
      source: "model_api_key",
      credential_ref: "INFERENCE_API_KEY_SECOND",
    });
    expect(() => compileAgentWorkbenchRecipe(recipe)).toThrow();
    recipe.environment.pop();
    recipe.outputs.results_path = "/logs/agent/../result.json";
    expect(() => compileAgentWorkbenchRecipe(recipe)).toThrow();
    expect(containsCredentialMaterial("${INFERENCE_API_KEY_EXAMPLE}")).toBe(true);
  });
  it("rejects unsafe endpoints and literal or extra worker credentials", () => {
    for (const url of [
      "http://inference.example.invalid/v1",
      "https://user:synthetic@inference.example.invalid/v1",
      "https://inference.example.invalid/v1?token=synthetic",
    ]) {
      const { manifest } = fixture();
      manifest.bindings[0]!.uses[0]!.base_url = url;
      expect(() => new InferenceBindings(manifest)).toThrow();
    }
    const { policy, job } = fixture();
    for (const value of [
      "synthetic-not-a-key",
      "${OAUTH_CLIENT_SECRET}",
      "${INFERENCE_API_KEY_EXAMPLE:-default}",
    ]) {
      const config = job();
      config.agents![0]!.env!.OPENAI_API_KEY = value;
      expect(() => policy.selected(config, actor, image)).toThrow();
    }
    const config = job();
    config.agents![0]!.env!.EXTRA_API_KEY = "synthetic-not-a-key";
    expect(() => policy.selected(config, actor, image)).toThrow();
  });
  it("native starter passes model unchanged without rewriting saved HF recipe", () => {
    const before = structuredClone(fastAgentWorkbenchStarter);
    const native = nativeFastAgentStarter(fastAgentWorkbenchStarter);
    expect(native.run_command).toContain('--model "$AGENT_MODEL"');
    expect(native.run_command).not.toContain("HF_TOKEN");
    expect(native.setup_command).toBe(before.setup_command);
    expect(native.environment.some((entry) => entry.source === "model_base_url")).toBe(
      false,
    );
    if (native.environment[0]) native.environment[0].name = "CHANGED_LOCAL_DRAFT";
    expect(fastAgentWorkbenchStarter).toEqual(before);
    expect(() =>
      new InferenceBindings().compile(native, actor, image, "native:model", () => true),
    ).toThrow();
  });
});

it("rejects credential-bearing URLs without weakening shell or runtime template admission", () => {
  const { recipe } = fixture();
  for (const command of [
    "curl https://user:synthetic-only@example.invalid/",
    "curl https://example.invalid/?token=synthetic-only",
  ]) {
    expect(() =>
      compileAgentWorkbenchRecipe({ ...recipe, run_command: command }),
    ).toThrow("credential-like");
  }
  recipe.environment.push({
    name: "EXAMPLE_URL",
    source: "literal",
    value: "https://example.invalid/?token=synthetic-only",
  });
  expect(() => compileAgentWorkbenchRecipe(recipe)).toThrow("credential");
});

it("rejects ambiguous review grants and keeps source aliases out of compiled configs", () => {
  const { manifest, recipe } = fixture();
  const binding = manifest.bindings[0];
  const grant = binding?.uses[0];
  if (!binding || !grant) throw Error("fixture required");
  binding.uses.push({ ...grant, allowed_hosts: ["other.example.invalid"] });
  const ambiguous = new InferenceBindings(manifest);
  expect(() =>
    ambiguous.compile(recipe, actor, image, "example:native", () => true),
  ).toThrow("not reviewed");
  expect(JSON.stringify(ambiguous)).toBe("{}");
  binding.uses.pop();
  recipe.run_command = "echo INFERENCE_SECRET_EXAMPLE";
  grant.recipe_digest = inferenceRecipeDigest(
    compileAgentWorkbenchRecipe(recipe).harbor_agent,
  );
  expect(() =>
    new InferenceBindings(manifest).compile(
      recipe,
      actor,
      image,
      "example:native",
      () => true,
    ),
  ).toThrow("not reviewed");
});

it("requires exact native model and routing identity at compile and immutable-config admission", () => {
  const { recipe, manifest, policy, job } = fixture();
  // Routing options are opaque agent data, not parsed or normalized by control.
  const routed =
    "native:model?routeApi=responses&baseUrl=https://synthetic.example.invalid/v1";
  for (const model of ["example:different-model", routed]) {
    expect(() => policy.compile(recipe, actor, image, model, () => true)).toThrow(
      "not reviewed",
    );
    const config = job();
    config.agents![0]!.model_name = model;
    expect(() => policy.selected(config, actor, image)).toThrow("not reviewed");
  }
  manifest.bindings[0]!.uses[0]!.allowed_models = [routed];
  const reviewed = new InferenceBindings(manifest);
  const compiled = reviewed.compile(recipe, actor, image, routed, () => true);
  const config = job();
  config.agents = [compiled];
  expect(reviewed.selected(config, actor, image)?.ref).toBe(
    "INFERENCE_API_KEY_EXAMPLE",
  );
  for (const changed of [
    routed.replace("responses", "chat-completions"),
    routed.replace("synthetic.example", "other.example"),
    `${routed}&extra=true`,
  ]) {
    config.agents[0]!.model_name = changed;
    expect(() => reviewed.selected(config, actor, image)).toThrow("not reviewed");
  }
  config.agents[0]!.model_name = routed;
  const kwargs = config.agents[0]!.kwargs as { config: { route_api: string } };
  kwargs.config.route_api = "responses";
  expect(() => reviewed.selected(config, actor, image)).toThrow("not reviewed");
});

it.each([
  "harbor_hf_agents.command_agent.agent:CommandAgent",
  "synthetic.compatible:Agent",
])("applies the same legacy environment-template restriction to %s", (importPath) => {
  const policy = new InferenceBindings();
  const config = fixture().job();
  config.agents = [
    {
      import_path: importPath,
      env: {
        OPENAI_API_KEY: "${HF_INFERENCE_TOKEN}",
        OPENAI_BASE_URL: "https://router.huggingface.co/v1",
      },
    },
  ];
  expect(policy.selected(config, actor, image)).toBeNull();
  config.agents[0]!.env!.OPENAI_BASE_URL = "https://synthetic.example.invalid/v1";
  expect(() => policy.selected(config, actor, image)).toThrow("not reviewed");
  config.agents = [
    { import_path: importPath },
    { name: "synthetic", env: { HF_TOKEN: "${HF_INFERENCE_TOKEN}" } },
  ];
  expect(policy.selected(config, actor, image)).toBeNull();
});

it("validates supplied private source transitions without serializing alias fingerprints", () => {
  const { manifest, policy } = fixture();
  expect(() =>
    new InferenceBindings(manifest).assertSourceTransitionFrom(policy),
  ).not.toThrow();
  manifest.bindings[0]!.enabled = false;
  expect(() =>
    new InferenceBindings(manifest).assertSourceTransitionFrom(policy),
  ).not.toThrow();
  manifest.bindings[0]!.source_env = "INFERENCE_SECRET_REPLACEMENT";
  expect(() =>
    new InferenceBindings(manifest).assertSourceTransitionFrom(policy),
  ).toThrow("requires a new reference");
  manifest.bindings[0]!.ref = "INFERENCE_API_KEY_REPLACEMENT";
  expect(() =>
    new InferenceBindings(manifest).assertSourceTransitionFrom(policy),
  ).not.toThrow();
  expect(() =>
    new InferenceBindings().assertSourceTransitionFrom(policy),
  ).not.toThrow();
  expect(JSON.stringify(policy)).toBe("{}");
});

it("allows conventional provider API-key sources but denies control and auth sources", () => {
  for (const source of [
    "DEEPSEEK_API_KEY",
    "EXAMPLE_API_KEY",
    "SECOND_API_KEY",
    "INFERENCE_SECRET_EXAMPLE",
  ]) {
    const { manifest } = fixture();
    manifest.bindings[0]!.source_env = source;
    expect(() => new InferenceBindings(manifest)).not.toThrow();
  }
  for (const source of [
    "HF_TOKEN",
    "HF_INFERENCE_TOKEN",
    "OAUTH_CLIENT_SECRET",
    "OAUTH_API_KEY",
    "CONTROL_API_KEY",
    "HF_API_KEY",
    "OPENID_API_KEY",
    "SESSION_API_KEY",
    "INFERENCE_API_KEY_EXAMPLE",
    "INFERENCE_SECRET_HF_TOKEN",
    "INFERENCE_SECRET_OAUTH_CLIENT_SECRET",
  ]) {
    const { manifest } = fixture();
    manifest.bindings[0]!.source_env = source;
    expect(() => new InferenceBindings(manifest)).toThrow(
      "Invalid inference binding manifest",
    );
  }
});

it("derives fresh review grants offline from the returned fragment, not the recipe digest", () => {
  const data = fixture();
  const preview = compileAgentWorkbenchRecipe(data.recipe);
  // Same JSON round trip an operator saves from the existing preview response.
  const saved = JSON.parse(JSON.stringify(preview));
  expect(inferenceRecipeDigest(saved.harbor_agent)).toBe(
    data.manifest.bindings[0]!.uses[0]!.recipe_digest,
  );
  expect(inferenceRecipeDigest(saved.harbor_agent)).not.toBe(preview.recipe_digest);
  expect(
    inferenceRecipeDigest({ ...saved.harbor_agent, model_name: "second:native" }),
  ).toBe(inferenceRecipeDigest(saved.harbor_agent));
  for (const recipe of [
    { ...data.recipe, run_command: "different command" },
    { ...data.recipe, setup_timeout_seconds: 31 },
    {
      ...data.recipe,
      environment: data.recipe.environment.map((entry) =>
        entry.source === "model_api_key" ? { ...entry, name: "OTHER_API_KEY" } : entry,
      ),
    },
  ]) {
    expect(
      inferenceRecipeDigest(compileAgentWorkbenchRecipe(recipe).harbor_agent),
    ).not.toBe(inferenceRecipeDigest(saved.harbor_agent));
  }
});

it.each(["EXAMPLE", "SECOND"])(
  "allows conventional source %s only as its approved destination key",
  (suffix) => {
    const { recipe, manifest } = fixture(suffix);
    const source = `${suffix}_API_KEY`;
    manifest.bindings[0]!.source_env = source;
    const policy = new InferenceBindings(manifest);
    const compiled = policy.compile(recipe, actor, image, "example:native", () => true);
    expect(compiled.kwargs.config.run.bindings[source]).toBe("model_api_key");
    expect(policy.selected({ agents: [compiled] }, actor, image)?.ref).toBe(
      manifest.bindings[0]!.ref,
    );
    expect(JSON.stringify(policy.discovery(actor, () => true))).not.toContain(source);
    for (const value of [source, `echo $${source}`, `\${${source}:-fallback}`]) {
      const changed = structuredClone(compiled);
      changed.kwargs.config.run.literals = { NOTE: value };
      manifest.bindings[0]!.uses[0]!.recipe_digest = inferenceRecipeDigest(changed);
      expect(() =>
        new InferenceBindings(manifest).selected({ agents: [changed] }, actor, image),
      ).toThrow("not reviewed");
    }
  },
);

it.each(["label", "model", "url", "host"])(
  "rejects conventional source aliases in manifest %s without echoing inputs",
  (field) => {
    const { manifest } = fixture();
    const binding = manifest.bindings[0]!;
    binding.source_env = "EXAMPLE_API_KEY";
    const grant = binding.uses[0]!;
    if (field === "label") binding.label = "Private EXAMPLE_API_KEY";
    if (field === "model") grant.allowed_models = ["example:EXAMPLE_API_KEY"];
    if (field === "url") grant.base_url = "https://example.invalid/EXAMPLE_API_KEY";
    if (field === "host") grant.allowed_hosts = ["EXAMPLE_API_KEY.example.invalid"];
    expect(() => new InferenceBindings(manifest)).toThrow(
      "Invalid inference binding manifest",
    );
  },
);

it.each(["setup", "run", "literal", "output", "model", "env", "template", "job"])(
  "audits conventional source mentions in %s even with an exact review digest",
  (field) => {
    const { manifest, recipe, compile } = fixture();
    manifest.bindings[0]!.source_env = "EXAMPLE_API_KEY";
    const agent = compile();
    const source = "EXAMPLE_API_KEY";
    if (field === "setup") agent.kwargs.config.setup.script = `echo ${source}`;
    if (field === "run") agent.kwargs.config.run.script = `echo ${source}`;
    if (field === "literal") agent.kwargs.config.run.literals = { NOTE: source };
    if (field === "output") agent.kwargs.config.outputs = [{ path: source }];
    if (field === "model") agent.model_name = `example:${source}`;
    if (field === "env") agent.env = { ...agent.env, NOTE: source };
    if (field === "template")
      agent.kwargs.config.run.literals = { NOTE: `\${${source}:-default}` };
    manifest.bindings[0]!.uses[0]!.recipe_digest = inferenceRecipeDigest(agent);
    const policy = new InferenceBindings(manifest);
    const job = { agents: [agent], ...(field === "job" ? { job_name: source } : {}) };
    expect(() => policy.selected(job, actor, image)).toThrow("not reviewed");
    recipe.run_command = `echo ${source}`;
    manifest.bindings[0]!.uses[0]!.recipe_digest = inferenceRecipeDigest(
      compileAgentWorkbenchRecipe(recipe).harbor_agent,
    );
    expect(() =>
      new InferenceBindings(manifest).compile(
        recipe,
        actor,
        image,
        "example:native",
        () => true,
      ),
    ).toThrow("not reviewed");
  },
);

it("checks labels against other bindings' private identities and audits the legacy path", () => {
  const first = fixture();
  const second = fixture("SECOND");
  second.manifest.bindings[0]!.source_env = "SECOND_API_KEY";
  first.manifest.bindings.push(second.manifest.bindings[0]!);
  first.manifest.bindings[0]!.label = "Uses SECOND_API_KEY";
  expect(() => new InferenceBindings(first.manifest)).toThrow(
    "Invalid inference binding manifest",
  );
  first.manifest.bindings[0]!.label = "Safe inference";
  const policy = new InferenceBindings(first.manifest);
  const recipe = { ...fastAgentWorkbenchStarter, run_command: "echo SECOND_API_KEY" };
  expect(() => policy.compile(recipe, actor, image, undefined, () => true)).toThrow(
    "not reviewed",
  );
  expect(() =>
    policy.selected({ agents: [{ model_name: "SECOND_API_KEY" }] }, actor, image),
  ).toThrow("not reviewed");
});

it.each(["rogue-key", "dotted-path", "default-template"])(
  "does not extend the destination exception to %s",
  (field) => {
    const { manifest, compile } = fixture();
    manifest.bindings[0]!.source_env = "EXAMPLE_API_KEY";
    const agent = compile();
    if (field === "rogue-key")
      agent.kwargs.config.run.literals = { EXAMPLE_API_KEY: "harmless" };
    if (field === "dotted-path")
      agent.kwargs["config.run.bindings"] = { EXAMPLE_API_KEY: "model_api_key" };
    if (field === "default-template")
      agent.env = { OPENAI_API_KEY: "${EXAMPLE_API_KEY:-fallback}" };
    manifest.bindings[0]!.uses[0]!.recipe_digest = inferenceRecipeDigest(agent);
    expect(() =>
      new InferenceBindings(manifest).selected({ agents: [agent] }, actor, image),
    ).toThrow("not reviewed");
  },
);

it.each(["chat-completions", "responses"] as const)(
  "rejects durable non-native key-only grants: %s",
  (route) => {
    const { manifest } = fixture();
    manifest.bindings[0]!.uses[0]!.route_api = route;
    expect(() => new InferenceBindings(manifest)).toThrow(
      "Invalid inference binding manifest",
    );
  },
);
