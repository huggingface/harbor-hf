// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { clearPendingRun, pendingRunId } from "../src/pending-run";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});
it("adopts an ambiguous request only for the same actor and exact review", () => {
  const id = pendingRunId("actor-a", "exact-review");
  expect(pendingRunId("actor-a", "exact-review")).toBe(id);
  expect(pendingRunId("actor-b", "exact-review")).not.toBe(id);
  expect(pendingRunId("actor-a", "changed-review")).not.toBe(id);
  clearPendingRun("actor-a");
  expect(pendingRunId("actor-a", "exact-review")).not.toBe(id);
});
it("survives unavailable or corrupted browser storage", () => {
  window.localStorage.setItem("harbor-hf.new-run.pending.v1:actor", "malformed");
  expect(pendingRunId("actor", "review")).toBeTruthy();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  expect(pendingRunId("actor", "review")).toBeTruthy();
  expect(() => clearPendingRun("actor")).not.toThrow();
});
