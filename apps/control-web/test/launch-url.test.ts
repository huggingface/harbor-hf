import { describe, expect, it } from "vitest";
import { draftUrl, draftUrlLimit, loadDraftUrl } from "../src/launch-url";

const base = "https://example.test/runs/new";
describe("native launch draft URLs", () => {
  it("round-trips native fields, Unicode, null, false, zero, and empty values", () => {
    const draft = {
      agents: [
        {
          name: "acp",
          kwargs: {
            source: {
              repo_url: "https://github.com/example/agent.git",
              ref: "a".repeat(40),
            },
          },
        },
      ],
      extra_instructions: ["a+b & ü 🦆"],
      verifier: { disable: false, override_timeout_sec: null },
      n_attempts: 0,
      tasks: [],
      text: "",
    };
    const url = new URL(draftUrl(`${base}?unrelated=old#fragment`, draft, "0.25"));
    expect(url.search).toContain("draft=%7B");
    expect(url.searchParams.has("unrelated")).toBe(false);
    expect(url.hash).toBe("");
    expect(loadDraftUrl(url.search)).toEqual({ draft, ceiling: "0.25" });
    expect(draft).not.toHaveProperty("validation");
  });
  it("supports an omitted cost input and does not invent a draft without a query", () => {
    expect(loadDraftUrl("?draft=%7B%7D")).toEqual({ draft: {}, ceiling: "1" });
    expect(loadDraftUrl("?unrelated=1")).toBeNull();
  });
  it.each([
    "?draft={",
    "?draft=null",
    "?draft=[]",
    "?draft=1",
    "?draft={}&draft={}",
    "?cost_ceiling_usd=1",
    "?draft={}&cost_ceiling_usd=1&cost_ceiling_usd=2",
    "?draft={}&cost_ceiling_usd=0",
    "?draft={}&cost_ceiling_usd=NaN",
    "?draft={}&cost_ceiling_usd=10001",
  ])("rejects invalid query %s", (search) => {
    expect(() => loadDraftUrl(search)).toThrow();
  });
  it("rejects credential material during both sharing and loading", () => {
    const unsafe = { agents: [{ env: { HF_TOKEN: "test-only" } }] };
    expect(() => draftUrl(base, unsafe, "1")).toThrow("credential");
    expect(() =>
      loadDraftUrl(`?draft=${encodeURIComponent(JSON.stringify(unsafe))}`),
    ).toThrow("credential");
  });
  it("bounds encoded URL size without truncating configuration", () => {
    expect(() =>
      draftUrl(base, { extra_instructions: ["ü".repeat(draftUrlLimit)] }, "1"),
    ).toThrow("too large");
    expect(() => loadDraftUrl(`?draft=${"a".repeat(draftUrlLimit)}`)).toThrow("8 KiB");
    expect(() => draftUrl(base, {}, "-1")).toThrow("cost");
  });
});
