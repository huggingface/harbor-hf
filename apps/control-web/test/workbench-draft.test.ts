// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadWorkbenchDraft,
  saveWorkbenchDraft,
  workbenchDraftKey,
  type WorkbenchDraft,
} from "../src/workbench-draft";

const draft: WorkbenchDraft = {
  recipe: {
    schema_version: "v1",
    name: "",
    setup_command: "echo edited",
    run_command: "",
    route_api: "responses",
    setup_timeout_seconds: 60,
    environment: [{ name: "X", source: "literal", value: "draft" }],
    outputs: { results_path: "", trajectory_path: null },
  },
  benchmarkKey: "terminal-bench-2-1\none-task-1-trial",
  model: "publisher/model",
  provider: "provider",
  ceiling: "0.25",
  role: "diagnostic",
};

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("Workbench draft storage", () => {
  it("round trips incomplete edits without confirmation or setup state", () => {
    expect(saveWorkbenchDraft(draft)).toBe(true);
    expect(loadWorkbenchDraft()).toEqual(draft);
    expect(loadWorkbenchDraft()).not.toHaveProperty("confirmed");
    expect(loadWorkbenchDraft()).not.toHaveProperty("setup");
  });

  it.each(["invalid JSON", "null", '{"recipe":{"environment":null}}'])(
    "ignores malformed storage: %s",
    (value) => {
      window.localStorage.setItem(workbenchDraftKey, value);
      expect(loadWorkbenchDraft()).toBeNull();
    },
  );

  it("handles unavailable storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(loadWorkbenchDraft()).toBeNull();
    expect(saveWorkbenchDraft(draft)).toBe(false);
  });
});
