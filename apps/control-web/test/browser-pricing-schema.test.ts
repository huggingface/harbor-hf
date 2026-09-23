import { expect, it } from "vitest";
import validate from "../src/generated/browser-pricing-validator.js";

const rates = () => ({ input: 0, output: 1, cached: null });
const scenario = (): Record<string, unknown> => ({
  id: "example",
  name: "Example",
  standard: rates(),
  longContext: rates(),
  threshold: 0,
});
const preferences = (item: unknown = scenario()): Record<string, unknown> => ({
  schema_version: "v1",
  scenarios: [item],
  selected_id: "example",
  tier: "standard",
});

it("rejects malformed root and scenario objects without coercing stored preferences", () => {
  for (const invalid of [null, [], "preferences", 1, false]) {
    expect(validate(invalid)).toBe(false);
    expect(validate(preferences(invalid))).toBe(false);
  }
  for (const key of Object.keys(preferences())) {
    const missing = preferences();
    delete missing[key];
    expect(validate(missing)).toBe(false);
  }
  for (const key of Object.keys(scenario())) {
    const missing = scenario();
    delete missing[key];
    expect(validate(preferences(missing))).toBe(false);
  }
  for (const selected_id of ["", "x".repeat(65), 1, {}, []])
    expect(validate({ ...preferences(), selected_id })).toBe(false);
  for (const scenarios of [null, {}, "invalid", false])
    expect(validate({ ...preferences(), scenarios })).toBe(false);
  for (const id of [null, 1, "", "invalid/id", "x".repeat(65)])
    expect(validate(preferences({ ...scenario(), id }))).toBe(false);
  for (const name of [null, 1, "", " ", "x".repeat(81)])
    expect(validate(preferences({ ...scenario(), name }))).toBe(false);
  expect(validate(preferences({ ...scenario(), extra: true }))).toBe(false);
  expect(validate({ ...preferences(), extra: true })).toBe(false);
});

it.each(["standard", "longContext"])(
  "checks every nullable %s rate independently at its schema boundary",
  (tier) => {
    for (const invalid of [null, [], "rates", 1])
      expect(validate(preferences({ ...scenario(), [tier]: invalid }))).toBe(false);
    for (const key of ["input", "output", "cached"]) {
      const missing: Record<string, unknown> = rates();
      delete missing[key];
      expect(validate(preferences({ ...scenario(), [tier]: missing }))).toBe(false);
      for (const invalid of ["0", {}, false, -1, 1_000_001, NaN, Infinity]) {
        const candidate = preferences({
          ...scenario(),
          [tier]: { ...rates(), [key]: invalid },
        });
        const before = structuredClone(candidate);
        expect(validate(candidate)).toBe(false);
        expect(candidate).toEqual(before);
      }
      for (const valid of [null, 0, 0.5, 1_000_000])
        expect(
          validate(
            preferences({ ...scenario(), [tier]: { ...rates(), [key]: valid } }),
          ),
        ).toBe(true);
    }
    expect(
      validate(preferences({ ...scenario(), [tier]: { ...rates(), extra: 1 } })),
    ).toBe(false);
  },
);

it("handles simultaneous errors, safe integer limits and Unicode names", () => {
  expect(
    validate({
      schema_version: "v2",
      selected_id: {},
      tier: "unknown",
      extra: true,
      scenarios: [{ id: 1, name: [], threshold: -1, standard: {}, longContext: [] }],
    }),
  ).toBe(false);
  for (const threshold of [null, "0", 0.1, -1, Number.MAX_SAFE_INTEGER + 1])
    expect(validate(preferences({ ...scenario(), threshold }))).toBe(false);
  for (const threshold of [0, Number.MAX_SAFE_INTEGER])
    expect(validate(preferences({ ...scenario(), threshold }))).toBe(true);
  expect(validate({ ...preferences(), selected_id: null, scenarios: [] })).toBe(true);
  for (const name of ["Example 😀", "\ud800x", "\ud800", "\udc00"])
    expect(validate(preferences({ ...scenario(), name }))).toBe(true);
});
