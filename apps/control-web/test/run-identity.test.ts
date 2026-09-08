import { describe, expect, it } from "vitest";
import type { RunRecord } from "../src/api";
import { runIdentity } from "../src/run-identity";

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
    expect(result.reasoning).toBe("off, high, Native default");
  });
  it("keeps missing identities unavailable rather than using preset metadata", () => {
    expect(identity(undefined).model).toBe("Unavailable");
    expect(identity([null]).model).toBe("Unspecified");
    expect(identity([{}]).agent).toBe("Unspecified");
    expect(identity([{}]).provider).toBe("Unspecified");
    expect(identity([{}]).version).toBe("Harbor bundled");
  });
});
