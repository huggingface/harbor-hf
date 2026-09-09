import { expect, it } from "vitest";
import { runPresentationPath, validateRunPresentation } from "../src/index.js";
const record = {
  schema_version: "v1",
  run_id: "run-0123456789abcdef01234567",
  archived: true,
  revision: 1,
  updated_at: "2026-01-01T00:00:00Z",
  actor: "fixture-subject",
};
it("validates archive-only durable metadata and its canonical path", () => {
  expect(validateRunPresentation(record)).toEqual(record);
  expect(runPresentationPath(record.run_id)).toBe(
    `runs/${record.run_id}/presentation.json`,
  );
  expect(() => runPresentationPath("../invalid")).toThrow();
});
it.each([
  { revision: 0 },
  { revision: 1.1 },
  { archived: "true" },
  { schema_version: "v2" },
  { updated_at: "invalid" },
  { actor: "" },
  { run_id: "invalid" },
  { notes: "not supported" },
])("rejects malformed presentation: %j", (change) => {
  expect(() => validateRunPresentation({ ...record, ...change })).toThrow();
});
it.each(Object.keys(record))("requires %s without fabricated defaults", (key) => {
  const value: Record<string, unknown> = { ...record };
  delete value[key];
  expect(() => validateRunPresentation(value)).toThrow();
});
