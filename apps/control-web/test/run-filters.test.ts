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
        archive: "not-archived",
        role: "all",
        q: "",
      });
    },
  );
  it.each(["diagnostic", "final"])("round-trips exact role and search: %s", (role) => {
    const params = updateRunFilters(new URLSearchParams("other=kept"), "role", role);
    const next = updateRunFilters(params, "q", "recipe + ü");
    expect(readRunFilters(next)).toEqual({
      archive: "not-archived",
      role,
      q: "recipe + ü",
    });
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

it.each(["", "?archive=invalid", "?archive=ACTIVE", "?archive=false"])(
  "defaults archive visibility safely: %s",
  (search) => {
    const filters = readRunFilters(new URLSearchParams(search));
    expect(filters.archive).toBe("not-archived");
    expect(
      matchesRunFilters(record, filters, { archived: true } as NonNullable<
        import("../src/api").RunView["presentation"]
      >),
    ).toBe(false);
    expect(matchesRunFilters(record, filters)).toBe(true);
  },
);
it("combines archive, role and query without discarding URL parameters", () => {
  const params = updateRunFilters(
    new URLSearchParams("role=diagnostic&q=recipe-one&other=kept"),
    "archive",
    "archived",
  );
  const presentation = { archived: true } as NonNullable<
    import("../src/api").RunView["presentation"]
  >;
  expect(matchesRunFilters(record, readRunFilters(params), presentation)).toBe(true);
  expect(matchesRunFilters(record, readRunFilters(params))).toBe(false);
  params.set("role", "final");
  expect(matchesRunFilters(record, readRunFilters(params), presentation)).toBe(false);
  expect(updateRunFilters(params, "archive", "not-archived").has("archive")).toBe(
    false,
  );
  expect(updateRunFilters(params, "archive", "all").get("other")).toBe("kept");
});

it("keeps unknown archives discoverable without discarding last-known archived state", () => {
  const filters = { role: "all", q: "", archive: "not-archived" } as const;
  expect(matchesRunFilters(record, filters, null, false)).toBe(true);
  expect(matchesRunFilters(record, { ...filters, archive: "all" }, null, false)).toBe(
    true,
  );
  expect(
    matchesRunFilters(record, { ...filters, archive: "archived" }, null, false),
  ).toBe(false);
  const archived = { archived: true } as NonNullable<
    import("../src/api").RunView["presentation"]
  >;
  expect(matchesRunFilters(record, filters, archived, false)).toBe(false);
  expect(
    matchesRunFilters(record, { ...filters, archive: "archived" }, archived, false),
  ).toBe(true);
  expect(matchesRunFilters(record, { ...filters, role: "final" }, null, false)).toBe(
    false,
  );
});
