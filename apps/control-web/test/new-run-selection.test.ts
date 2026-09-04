import {
  compileAgentWorkbenchRecipe,
  fastAgentWorkbenchStarter,
  fxWorkbenchStarter,
} from "@harbor-hf/control-core";
import { describe, expect, it } from "vitest";
import type { BenchmarkConfig, ProfileList, WorkbenchSetup } from "../src/api";
import {
  approvedProfile,
  builtinRouteAvailable,
  matchingConfigurations,
  matchingSetup,
} from "../src/new-run-selection";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture");
  return value;
}

function profile(
  kind: ProfileList["items"][number]["profile_kind"],
  alias: string,
  spec: Record<string, unknown>,
): ProfileList["items"][number] {
  return {
    profile_id: `sha256:${alias}`,
    profile_kind: kind,
    name: alias,
    alias,
    approved_aliases: [alias],
    promotion_state: "approved",
    source: "built-in",
    spec,
    created_at: "2026-09-04T00:00:00Z",
  };
}
const profiles = [
  profile("model", "first", { model_id: "example/model-a" }),
  profile("model", "second", { model_id: "example/model-b" }),
  profile("harness", "agent-a", {}),
  profile("harness", "agent-b", {}),
  profile("deployment", "reviewed", { harnesses: ["agent-a", "agent-b"] }),
];
const configs: BenchmarkConfig[] = ["first", "second"].map((model) => ({
  name: model,
  revision: `sha256:${model}`,
  benchmark: "benchmark-subset",
  model,
  deployment: "reviewed",
  launch_policy: "diagnostic",
  size: "small",
  label: model,
  description: "Reviewed fixture",
  default_ceiling_microusd: 1_000_000,
  max_ceiling_microusd: 2_000_000,
  task_count: 2,
  publication_role: "diagnostic",
}));

describe("New Run reviewed selection", () => {
  it("uses the same reviewed path for two model strings and harnesses", () => {
    for (const [index, model] of ["example/model-a", "example/model-b"].entries()) {
      const matches = matchingConfigurations(
        configs,
        profiles,
        "benchmark-subset",
        model,
      );
      expect(matches).toEqual([configs[index]]);
      for (const harness of ["agent-a", "agent-b"])
        expect(builtinRouteAvailable(required(matches[0]), profiles, harness)).toBe(
          true,
        );
    }
  });
  it("rejects unknown model strings, aliases, arbitrary subsets and revoked promotions", () => {
    for (const model of [
      "unknown/model",
      "first",
      " example/model-a",
      "example/model-a:other-provider",
    ])
      expect(
        matchingConfigurations(configs, profiles, "benchmark-subset", model),
      ).toEqual([]);
    expect(
      matchingConfigurations(configs, profiles, "arbitrary-subset", "example/model-a"),
    ).toEqual([]);
    expect(
      matchingConfigurations(
        configs,
        profiles.map((item) => ({ ...item, approved_aliases: [] })),
        "benchmark-subset",
        "example/model-a",
      ),
    ).toEqual([]);
    expect(approvedProfile(profiles, "model", "missing")).toBeUndefined();
  });
  it("never substitutes an unavailable built-in route", () => {
    expect(builtinRouteAvailable(required(configs[0]), profiles, "other-agent")).toBe(
      false,
    );
    expect(
      builtinRouteAvailable(
        { ...required(configs[0]), deployment: "unknown" },
        profiles,
        "agent-a",
      ),
    ).toBe(false);
    expect(
      builtinRouteAvailable(
        required(configs[0]),
        profiles.filter((item) => item.profile_kind !== "harness"),
        "agent-a",
      ),
    ).toBe(false);
  });
  it("requires exact recipe and compiler evidence for both saved starters", () => {
    for (const recipe of [fastAgentWorkbenchStarter, fxWorkbenchStarter]) {
      const preview = compileAgentWorkbenchRecipe(recipe);
      const setup: WorkbenchSetup = {
        setup_test_id: "setup-fixture",
        recipe_digest: preview.recipe_digest,
        revision_id: preview.revision_id,
        status: "passed",
        created_at: "2026-09-04T00:00:00Z",
        started_at: null,
        completed_at: null,
        exit_code: 0,
        error: null,
        files: [],
      };
      expect(matchingSetup(preview, [setup])).toEqual(setup);
      for (const changed of [
        { status: "failed" as const },
        { recipe_digest: "sha256:old" },
        { revision_id: "sha256:old-compiler" },
      ])
        expect(matchingSetup(preview, [{ ...setup, ...changed }])).toBeUndefined();
      expect(matchingSetup(preview, [])).toBeUndefined();
    }
  });
});
