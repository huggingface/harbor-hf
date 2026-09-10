import { InferenceBindingDenied } from "@harbor-hf/contracts";
export { InferenceBindingDenied } from "@harbor-hf/contracts";
import {
  canonicalJson,
  sha256,
  validateInferenceBindingManifest,
  type AgentWorkbenchRecipeV1,
  type HarborJobConfigV1,
  type InferenceBindingManifestV1,
} from "@harbor-hf/contracts";
import { containsCredentialMaterial } from "@harbor-hf/contracts/credentials";
import type { HarborAgentFragment } from "./presets.js";
import {
  compileAgentWorkbenchRecipe,
  isReservedWorkbenchEnvironment,
} from "./workbench.js";

import { INFERENCE_TOKEN_TEMPLATE, ROUTER_URL } from "./hf-config.js";

export function inferencePresence(
  present: (source: string) => boolean,
  source: string,
): boolean {
  try {
    return present(source);
  } catch {
    throw new InferenceBindingDenied("Inference credential presence is unavailable");
  }
}

const denied = () => new InferenceBindingDenied();
const template = /^\$\{(INFERENCE_API_KEY_[A-Z0-9_]{1,48})\}$/;
type Binding = InferenceBindingManifestV1["bindings"][number];
type Grant = Binding["uses"][number];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw denied();
  return value as Record<string, unknown>;
}

// This is review identity, not another recipe record or Harbor configuration.
export function inferenceRecipeDigest(agent: Record<string, unknown>): string {
  return sha256(
    canonicalJson({
      import_path: agent.import_path,
      override_setup_timeout_sec: agent.override_setup_timeout_sec,
      kwargs: agent.kwargs,
    }),
  );
}

export function workbenchCredentialRef(recipe: AgentWorkbenchRecipeV1): string | null {
  const keys = recipe.environment.filter((entry) => entry.source === "model_api_key");
  const refs = new Set(keys.map((entry) => entry.credential_ref ?? null));
  if (refs.size > 1) throw denied();
  return keys[0]?.credential_ref ?? null;
}

/** Private immutable deployment policy. No environment access, provider probes or persistence. */
export class InferenceBindings {
  readonly #manifest: InferenceBindingManifestV1;

  constructor(value: unknown = { schema_version: "v1", bindings: [] }) {
    try {
      this.#manifest = structuredClone(validateInferenceBindingManifest(value));
      const refs = new Set<string>();
      const sources = new Set<string>();
      for (const binding of this.#manifest.bindings) {
        if (
          refs.has(binding.ref) ||
          sources.has(binding.source_env) ||
          this.hasSourceMention(binding.label) ||
          this.hasSourceMention(binding.ref)
        )
          throw denied();
        refs.add(binding.ref);
        sources.add(binding.source_env);
        for (const grant of binding.uses) {
          const { destination_env: _destinations, ...metadata } = grant;
          this.assertPublicStrings(metadata);
          if (grant.route_api !== "native" && grant.base_url === null) throw denied();
          if (grant.base_url !== null) {
            const url = new URL(grant.base_url);
            if (
              url.protocol !== "https:" ||
              url.username ||
              url.password ||
              url.search ||
              url.hash ||
              !grant.allowed_hosts.includes(url.hostname) ||
              containsCredentialMaterial(grant.base_url)
            )
              throw denied();
          }
          if (
            !grant.destination_env.length ||
            grant.destination_env.some(isReservedWorkbenchEnvironment)
          )
            throw denied();
        }
      }
    } catch {
      // Schema details and rejected inputs can contain private source aliases.
      throw new Error("Invalid inference binding manifest");
    }
  }

  private hasSourceMention(value: string): boolean {
    return (
      value.includes("INFERENCE_SECRET_") ||
      this.#manifest.bindings.some((binding) => value.includes(binding.source_env))
    );
  }

  /** Audit identities only, never credential values. The sole public exception is
   * an exact reviewed model-key destination in the command binding map. */
  assertPublicStrings(
    value: unknown,
    destinations: readonly string[] = [],
    path: string[] = [],
  ): void {
    if (typeof value === "string") {
      if (this.hasSourceMention(value)) throw denied();
    } else if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        this.assertPublicStrings(entry, destinations, [...path, String(index)]);
      });
    } else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        const destination =
          canonicalJson(path) ===
            canonicalJson(["kwargs", "config", "run", "bindings"]) &&
          entry === "model_api_key" &&
          destinations.includes(key);
        if (!destination && this.hasSourceMention(key)) throw denied();
        this.assertPublicStrings(entry, destinations, [...path, key]);
      }
    }
  }

  /** Private identity metadata only; never expose through discovery or run artifacts. */
  sourceIdentities(): { ref: string; source_env: string }[] {
    return this.#manifest.bindings.map(({ ref, source_env }) => ({ ref, source_env }));
  }

  assertSourceTransitionFrom(previous: InferenceBindings): void {
    for (const binding of this.sourceIdentities()) {
      const prior = previous
        .sourceIdentities()
        .find((entry) => entry.ref === binding.ref);
      if (prior && prior.source_env !== binding.source_env)
        throw new Error("Inference source identity change requires a new reference");
    }
  }

  discovery(actor: string, present: (source: string) => boolean) {
    return {
      schema_version: "v1",
      revision: 0,
      bindings: this.#manifest.bindings
        .filter((binding) =>
          binding.uses.some((use) => use.operator_subjects.includes(actor)),
        )
        .map((binding) => ({
          ref: binding.ref,
          label: binding.label,
          status: !binding.enabled
            ? "disabled"
            : inferencePresence(present, binding.source_env)
              ? "configured"
              : "missing",
        })),
    };
  }

  private reviewed(
    ref: string,
    actor: string,
    image: string,
    agent: Record<string, unknown>,
  ): { binding: Binding; grant: Grant } {
    const binding = this.#manifest.bindings.find(
      (entry) => entry.ref === ref && entry.enabled,
    );
    const config = record(record(agent.kwargs).config);
    const runBindings = record(record(config.run).bindings);
    if (
      config.route_api !== "native" &&
      !Object.values(runBindings).includes("model_base_url")
    )
      throw denied();
    const destinations = Object.entries(runBindings)
      .filter(([, source]) => source === "model_api_key")
      .map(([name]) => name)
      .sort();
    const matches = binding?.uses.filter(
      (use) =>
        use.operator_subjects.includes(actor) &&
        use.worker_image === image &&
        use.agent_import_path === agent.import_path &&
        use.recipe_digest === inferenceRecipeDigest(agent) &&
        use.route_api === config.route_api &&
        typeof agent.model_name === "string" &&
        use.allowed_models.includes(agent.model_name) &&
        canonicalJson([...use.destination_env].sort()) === canonicalJson(destinations),
    );
    const grant = matches?.[0];
    if (!binding || !grant || matches?.length !== 1) throw denied();
    if (
      Object.values(runBindings).includes("model_base_url") !==
      (grant.base_url !== null)
    )
      throw denied();
    this.assertPublicStrings(agent, grant.destination_env);
    return { binding, grant };
  }

  compile(
    recipe: AgentWorkbenchRecipeV1,
    actor: string,
    image: string,
    modelName: string | undefined,
    present: (source: string) => boolean,
  ): HarborAgentFragment {
    const preview = compileAgentWorkbenchRecipe(recipe);
    const ref = workbenchCredentialRef(preview.recipe);
    if (!ref) {
      if (recipe.route_api === "native") throw denied();
      this.assertPublicStrings({ ...preview.harbor_agent, model_name: modelName });
      return {
        ...preview.harbor_agent,
        ...(modelName === undefined ? {} : { model_name: modelName }),
      };
    }
    if (!modelName?.trim()) throw denied();
    const { binding, grant } = this.reviewed(ref, actor, image, {
      ...preview.harbor_agent,
      model_name: modelName,
    });
    if (!inferencePresence(present, binding.source_env)) throw denied();
    const needsUrl = recipe.environment.some(
      (entry) => entry.source === "model_base_url",
    );
    if (needsUrl !== (grant.base_url !== null)) throw denied();
    return {
      ...preview.harbor_agent,
      model_name: modelName,
      env: {
        OPENAI_API_KEY: `\${${ref}}`,
        ...(grant.base_url === null ? {} : { OPENAI_BASE_URL: grant.base_url }),
      },
      extra_allowed_hosts: [...grant.allowed_hosts],
    };
  }

  /** Recheck immutable native input against current grants at submit and every start/restart. */
  selected(
    config: HarborJobConfigV1,
    actor: string,
    image: string,
  ): { ref: string; source: string } | null {
    const { agents: _agents, ...jobMetadata } = config;
    this.assertPublicStrings(jobMetadata);
    const agents = config.agents ?? [];
    const selected = agents.filter((agent) =>
      Object.values(agent.env ?? {}).some((value) =>
        value.includes("INFERENCE_API_KEY_"),
      ),
    );
    if (!selected.length) {
      for (const agent of agents) {
        this.assertPublicStrings(agent);
        for (const [key, value] of Object.entries(agent.env ?? {})) {
          if (
            (key === "HF_TOKEN" || key === "OPENAI_API_KEY") &&
            value === INFERENCE_TOKEN_TEMPLATE
          )
            continue;
          if (containsCredentialMaterial(value, key)) throw denied();
        }
        if (
          agent.env?.OPENAI_API_KEY === INFERENCE_TOKEN_TEMPLATE &&
          agent.env.OPENAI_BASE_URL !== ROUTER_URL
        )
          throw denied();
      }
      return null;
    }
    if (agents.length !== 1 || selected.length !== 1) throw denied();
    const agent = selected[0];
    if (!agent) throw denied();
    const env = agent.env ?? {};
    const ref = template.exec(env.OPENAI_API_KEY ?? "")?.[1];
    if (!ref) throw denied();
    const { binding, grant } = this.reviewed(ref, actor, image, agent);
    const expected = {
      OPENAI_API_KEY: `\${${ref}}`,
      ...(grant.base_url === null ? {} : { OPENAI_BASE_URL: grant.base_url }),
    };
    if (
      canonicalJson(env) !== canonicalJson(expected) ||
      canonicalJson(agent.extra_allowed_hosts ?? []) !==
        canonicalJson(grant.allowed_hosts)
    )
      throw denied();
    return { ref, source: binding.source_env };
  }
}
