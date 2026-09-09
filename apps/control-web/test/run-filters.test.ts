import { describe, expect, it } from "vitest";
import type { RunRecord } from "../src/api";
import {
  matchesRunFilters,
  readRunFilters,
  updateRunFilters,
} from "../src/run-filters";

const record = {
  run_id: "run-0123456789abcdef01234567",
  role: "diagnostic",
  workbench_recipe: { name: "recipe-one" },
  submission: {
    benchmark: { name: "benchmark-one", preset: "sample" },
    model: {
      id: "catalog-model",
      provider: "catalog-provider",
      reasoning_effort: "off",
    },
    harness: { agent: "command-agent", version: "revision-one" },
  },
  harbor_job_config: {
    agents: [
      { import_path: "plugin:CommandAgent", model_name: "route/native-model:provider" },
    ],
  },
} as RunRecord;

describe("Runs navigation filters", () => {
  it.each(["", "?role=all", "?role=finished", "?role=FINAL"])(
    "defaults invalid roles to All: %s",
    (search) => {
      expect(readRunFilters(new URLSearchParams(search))).toEqual({
        role: "all",
        q: "",
      });
    },
  );
  it.each(["diagnostic", "final"])("round-trips exact role and search: %s", (role) => {
    const params = updateRunFilters(new URLSearchParams("other=kept"), "role", role);
    const next = updateRunFilters(params, "q", "recipe + ü");
    expect(readRunFilters(next)).toEqual({ role, q: "recipe + ü" });
    expect(next.get("other")).toBe("kept");
    expect(params.has("q")).toBe(false);
    expect(updateRunFilters(next, "q", "").has("q")).toBe(false);
    expect(updateRunFilters(next, "role", "all").has("role")).toBe(false);
  });
  it("uses recorded role, independently of outcomes", () => {
    expect(matchesRunFilters(record, { role: "final", q: "" })).toBe(false);
    expect(matchesRunFilters(record, { role: "diagnostic", q: "" })).toBe(true);
    expect(
      matchesRunFilters({ ...record, role: "final" }, { role: "final", q: "" }),
    ).toBe(true);
  });
  it.each([
    "  RECIPE-ONE  ",
    "012345",
    "BENCHMARK",
    "sample",
    "catalog-model",
    "catalog-provider",
    "native-model",
    "provider",
    "CommandAgent",
    "revision-one",
    "",
  ])("searches recorded identities without name branches: %s", (q) => {
    expect(matchesRunFilters(record, { role: "all", q })).toBe(true);
  });
  it("handles missing optional provenance and empty native agents", () => {
    const historical = {
      ...record,
      workbench_recipe: undefined,
      harbor_job_config: {},
    };
    expect(matchesRunFilters(historical, { role: "all", q: "recipe-one" })).toBe(false);
    expect(matchesRunFilters(historical, { role: "all", q: "benchmark-one" })).toBe(
      true,
    );
    expect(matchesRunFilters(record, { role: "all", q: "not-found" })).toBe(false);
  });
});
