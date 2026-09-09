import { describe, expect, it } from "vitest";
import type { RunRecord } from "../src/api";
import { runAgentIdentities, runIdentity } from "../src/run-identity";

const identity = (agents: unknown) =>
  runIdentity({ harbor_job_config: { agents } } as RunRecord);
describe("native run identities", () => {
  it("shows every agent, requested version, and model without first-agent attribution", () => {
    const result = identity([
      {
        name: "openclaw",
        model_name: "openai/example/first:provider",
        kwargs: { version: "one", thinking: "off" },
      },
      {
        name: "openclaw",
        model_name: "openai/example/second:other",
        kwargs: { version: "two", reasoning_effort: "high" },
      },
      {
        import_path: "example.agent:Agent",
        model_name: "openai/example/second:other",
        kwargs: { source: { ref: "a".repeat(40) } },
      },
    ]);
    expect(result.agent).toBe("openclaw, example.agent:Agent");
    expect(result.version).toBe(`one, two, ${"a".repeat(40)}`);
    expect(result.model).toBe(
      "openai/example/first:provider, openai/example/second:other",
    );
    expect(result.provider).toBe("provider, other");
    expect(result.reasoning).toBe(
      "thinking=off, reasoning_effort=high, Not recorded in native kwargs",
    );
  });
  it("keeps missing identities unavailable rather than using preset metadata", () => {
    expect(identity(undefined).model).toBe("Unavailable");
    expect(identity([null]).model).toBe("Unspecified");
    expect(identity([{}]).agent).toBe("Unspecified");
    expect(identity([{}]).provider).toBe("Unspecified");
    expect(identity([{}]).version).toBe("Not explicitly configured");
  });
});

describe("configuration provenance", () => {
  it("retains distinct per-agent model, version and reasoning associations", () => {
    const agents = [
      {
        name: "alpha",
        model_name: "route/first",
        kwargs: { version: "1", thinking: false },
      },
      {
        import_path: "plugin:Agent",
        model_name: "route/second?reasoning=max",
        kwargs: {},
      },
    ];
    const record = { harbor_job_config: { agents } } as RunRecord;
    const before = structuredClone(record);
    const rows = runAgentIdentities(record);
    expect(rows[0]).toMatchObject({
      model: "route/first",
      version: "1",
      reasoning: "thinking=false",
    });
    expect(rows[1]).toMatchObject({
      model: "route/second?reasoning=max",
      version: "Not explicitly configured",
      reasoning: "Not recorded in native kwargs",
    });
    expect(record).toEqual(before);
  });

  it("does not convert malformed option objects to claimed defaults or versions", () => {
    expect(identity([{ kwargs: { version: {}, reasoning_effort: [] } }])).toMatchObject(
      {
        version: "Not explicitly configured",
        reasoning: "reasoning_effort=Unrecognized value",
      },
    );
    expect(
      identity([{ kwargs: { thinking: 0, reasoning_effort: null } }]).reasoning,
    ).toBe("thinking=0");
  });
});

describe("Workbench display provenance", () => {
  it("prefers the immutable recipe name while retaining native agent and existing revision", () => {
    const record = {
      workbench_recipe: { name: "my-recipe" },
      submission: { harness: { agent: "command-agent", version: "recipe-revision" } },
      harbor_job_config: {
        agents: [{ import_path: "plugin:CommandAgent", model_name: "route/model" }],
      },
    } as RunRecord;
    expect(runIdentity(record)).toMatchObject({
      agent: "my-recipe",
      nativeAgent: "plugin:CommandAgent",
      version: "recipe-revision",
      model: "route/model",
    });
    expect(runAgentIdentities(record)[0]?.agent).toBe("plugin:CommandAgent");
    const { workbench_recipe: _recipe, ...historical } = record;
    expect(runIdentity(historical).agent).toBe("plugin:CommandAgent");
    expect(runIdentity(historical).version).toBe("Not explicitly configured");
  });
});
