// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkbenchDraftSaver,
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
  n_concurrent_trials: "64",
  model: "publisher/model",
  provider: "provider",
  harbor_agent: { model_name: "hf.publisher/runtime-model:together" },
  ceiling: "0.25",
  role: "diagnostic",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("Workbench draft storage", () => {
  it.each(["0.10.16", "0.10.21", "custom-build"])(
    "does not rewrite a saved recipe when starter defaults change: %s",
    (version) => {
      const saved = {
        ...draft,
        recipe: {
          ...draft.recipe,
          setup_command: `uv pip install fast-agent-mcp==${version}`,
          run_command: "printf custom-command",
        },
      };
      expect(saveWorkbenchDraft(saved)).toBe(true);
      const stored = window.localStorage.getItem(workbenchDraftKey);
      expect(loadWorkbenchDraft()).toEqual(saved);
      expect(window.localStorage.getItem(workbenchDraftKey)).toBe(stored);
    },
  );

  it.each(["100", "75", "high", "  arbitrary intent  ", "", "off"])(
    "persists reasoning verbatim: %j",
    (reasoning_effort) => {
      expect(saveWorkbenchDraft({ ...draft, reasoning_effort })).toBe(true);
      expect(loadWorkbenchDraft()?.reasoning_effort).toBe(reasoning_effort);
    },
  );
  // Deliberately synthetic credential-shaped sentinels, never real credentials.
  const unsafeReasoning = [
    `hf_${"SYNTHETIC".repeat(4)}`,
    `sk-${"SYNTHETIC".repeat(4)}`,
    `ghp_${"SYNTHETIC".repeat(4)}`,
    `Bearer ${"SYNTHETIC".repeat(4)}`,
    "https://example.invalid/?token=synthetic",
    "${HF_INFERENCE_TOKEN}",
    "-----BEGIN PRIVATE KEY----- synthetic",
  ];
  it.each(unsafeReasoning)(
    "omits credential reasoning at every write boundary: %j",
    (reasoning_effort) => {
      vi.useFakeTimers();
      const write = vi.spyOn(Storage.prototype, "setItem");
      const contaminated = { ...draft, reasoning_effort };
      const saver = createWorkbenchDraftSaver(vi.fn());
      expect(saveWorkbenchDraft(contaminated)).toBe(true);
      saver.schedule(contaminated);
      vi.advanceTimersByTime(400);
      saver.schedule(contaminated);
      saver.flush();
      vi.runAllTimers();
      expect(write).toHaveBeenCalledTimes(3);
      for (const [key, value] of write.mock.calls) {
        expect(key).toBe(workbenchDraftKey);
        expect(JSON.parse(value)).toEqual(draft);
      }
      expect(loadWorkbenchDraft()).toEqual(draft);
      expect(contaminated.reasoning_effort).toBe(reasoning_effort);
    },
  );

  it.each(unsafeReasoning)(
    "cleans existing contamination on load: %j",
    (reasoning_effort) => {
      const stored = { ...draft, extraDraftState: { keep: true }, reasoning_effort };
      window.localStorage.setItem(workbenchDraftKey, JSON.stringify(stored));
      window.localStorage.setItem("unrelated", "unchanged");
      expect(loadWorkbenchDraft()).toEqual(draft);
      expect(
        JSON.parse(window.localStorage.getItem(workbenchDraftKey) ?? "null"),
      ).toEqual({
        ...draft,
        extraDraftState: { keep: true },
      });
      expect(loadWorkbenchDraft()).toEqual(draft);
      expect(window.localStorage.getItem("unrelated")).toBe("unchanged");
    },
  );

  it.each([false, true])(
    "does not restore contamination when cleanup storage fails (%s)",
    (removalFails) => {
      window.localStorage.setItem(
        workbenchDraftKey,
        JSON.stringify({ ...draft, reasoning_effort: unsafeReasoning[0] }),
      );
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("quota");
      });
      if (removalFails)
        vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
          throw new Error("blocked");
        });
      expect(loadWorkbenchDraft()).toEqual(draft);
      if (!removalFails)
        expect(window.localStorage.getItem(workbenchDraftKey)).toBeNull();
    },
  );

  it("round trips incomplete edits without confirmation or setup state", () => {
    expect(saveWorkbenchDraft(draft)).toBe(true);
    expect(loadWorkbenchDraft()).toEqual(draft);
    expect(loadWorkbenchDraft()).not.toHaveProperty("confirmed");
    expect(loadWorkbenchDraft()).not.toHaveProperty("setup");
  });

  it("loads older drafts without inventing a harness model string", () => {
    const {
      harbor_agent: _agent,
      n_concurrent_trials: _concurrency,
      ...legacy
    } = draft;
    expect(saveWorkbenchDraft(legacy)).toBe(true);
    expect(loadWorkbenchDraft()).toEqual(legacy);
    expect(loadWorkbenchDraft()).not.toHaveProperty("harbor_agent");
    expect(loadWorkbenchDraft()).not.toHaveProperty("n_concurrent_trials");
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

describe("deferred Workbench persistence", () => {
  it("coalesces typing and serializes only the latest draft after idle", () => {
    vi.useFakeTimers();
    const write = vi.spyOn(Storage.prototype, "setItem");
    const onSaved = vi.fn();
    const saver = createWorkbenchDraftSaver(onSaved);
    saver.schedule(draft);
    vi.advanceTimersByTime(300);
    saver.schedule({ ...draft, model: "edited" });
    vi.advanceTimersByTime(399);
    expect(write).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(loadWorkbenchDraft()?.model).toBe("edited");
    expect(onSaved).toHaveBeenCalledWith(true);
  });

  it("flushes pending changes once and cancels the delayed write", () => {
    vi.useFakeTimers();
    const write = vi.spyOn(Storage.prototype, "setItem");
    const saver = createWorkbenchDraftSaver(vi.fn());
    saver.schedule(draft);
    saver.flush();
    saver.flush();
    vi.runAllTimers();
    expect(write).toHaveBeenCalledTimes(1);
    expect(loadWorkbenchDraft()).toEqual(draft);
  });

  it("reports storage failure and can save a later edit", () => {
    vi.useFakeTimers();
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new Error("quota exceeded");
    });
    const onSaved = vi.fn();
    const saver = createWorkbenchDraftSaver(onSaved);
    saver.schedule(draft);
    vi.advanceTimersByTime(400);
    expect(onSaved).toHaveBeenLastCalledWith(false);
    saver.schedule({ ...draft, model: "recovered" });
    saver.flush();
    expect(onSaved).toHaveBeenLastCalledWith(true);
    expect(loadWorkbenchDraft()?.model).toBe("recovered");
  });
});
