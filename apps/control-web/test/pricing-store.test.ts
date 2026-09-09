// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import {
  createPricingStore,
  PRICING_KEY,
  validPreferences,
  type SavedScenario,
} from "../src/pricing-store";
const scenario: SavedScenario = {
  id: "one",
  name: "Local",
  threshold: 272000,
  standard: { input: 2, output: 8, cached: 0.5 },
  longContext: { input: 4, output: 16, cached: 1 },
};
const value = () => ({
  schema_version: "v1",
  scenarios: [structuredClone(scenario)],
  selected_id: "one",
  tier: "standard",
});
beforeEach(() => {
  let tail = Promise.resolve();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_name: string, operation: () => void) => {
        const result = tail.then(operation);
        tail = result.then(() => {});
        return result;
      },
    },
  });
  localStorage.clear();
  vi.restoreAllMocks();
});
it("validates closed versioned records, bounds, IDs, finite numbers and unset/zero rates", async () => {
  expect(validPreferences(value())).toBe(true);
  for (const invalid of [
    { ...value(), schema_version: "v2" },
    { ...value(), token: "forbidden" },
    { ...value(), selected_id: "absent" },
    { ...value(), tier: "automatic" },
    { ...value(), scenarios: [scenario, scenario] },
    {
      ...value(),
      scenarios: Array.from({ length: 51 }, (_, i) => ({ ...scenario, id: String(i) })),
    },
    ...["", " ", "a".repeat(81)].map((name) => ({
      ...value(),
      scenarios: [{ ...scenario, name }],
    })),
    ...[-1, NaN, Infinity, 1000001, "2"].map((input) => ({
      ...value(),
      scenarios: [{ ...scenario, standard: { ...scenario.standard, input } }],
    })),
    ...[-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1].map((threshold) => ({
      ...value(),
      scenarios: [{ ...scenario, threshold }],
    })),
  ])
    expect(validPreferences(invalid)).toBe(false);
  expect(
    validPreferences({
      ...value(),
      scenarios: [{ ...scenario, standard: { input: null, cached: 0, output: null } }],
    }),
  ).toBe(true);
});
it("CRUD and explicit tier/selection survive reload without account/run data", async () => {
  const store = createPricingStore(() => localStorage);
  expect(await store.save(scenario)).toBe(true);
  expect(await store.save({ ...scenario, id: "two", name: "Second" })).toBe(true);
  await store.select("one", "longContext");
  await store.rename("one", " Renamed ");
  const reload = createPricingStore(() => localStorage);
  const stop = reload.subscribe(() => {});
  expect(reload.getSnapshot().preferences).toMatchObject({
    selected_id: "one",
    tier: "longContext",
    scenarios: [{ name: "Renamed" }, { id: "two" }],
  });
  expect(reload.getSnapshot()).toBe(reload.getSnapshot());
  await reload.remove("two");
  expect(reload.getSnapshot().preferences.selected_id).toBe("one");
  await reload.remove("one");
  expect(reload.getSnapshot().preferences.selected_id).toBeNull();
  await reload.reset();
  expect(reload.getSnapshot().preferences.scenarios).toEqual([]);
  expect(Object.keys(JSON.parse(localStorage.getItem(PRICING_KEY) ?? "{}"))).toEqual([
    "schema_version",
    "scenarios",
    "selected_id",
    "tier",
  ]);
  stop();
});
it("ignores malformed data without overwriting, supports explicit reset", async () => {
  for (const raw of [
    "{",
    JSON.stringify({ ...value(), scenarios: [scenario, scenario] }),
    "null",
    " ".repeat(65537),
  ]) {
    localStorage.setItem(PRICING_KEY, raw);
    const store = createPricingStore(() => localStorage);
    const stop = store.subscribe(() => {});
    expect(store.getSnapshot().blocked).toBe(true);
    expect(await store.save(scenario)).toBe(false);
    expect(localStorage.getItem(PRICING_KEY)).toBe(raw);
    expect(await store.reset()).toBe(true);
    expect(await store.save(scenario)).toBe(true);
    stop();
  }
});
it("quota and disabled storage fail visibly, retaining last successful state", async () => {
  const store = createPricingStore(() => localStorage);
  await store.save(scenario);
  const previous = store.getSnapshot().preferences;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(await store.select(null)).toBe(false);
  expect(store.getSnapshot().preferences).toEqual(previous);
  expect(store.getSnapshot().status).toMatch(/not saved/);
  const disabled = createPricingStore(() => {
    throw new Error("disabled");
  });
  const stop = disabled.subscribe(() => {});
  expect(disabled.getSnapshot().status).toMatch(/could not be read/);
  expect(await disabled.reset()).toBe(false);
  stop();
});
it("syncs external changes and clearing, and catches changes while unmounted", async () => {
  const store = createPricingStore(() => localStorage);
  const listener = vi.fn();
  const stop = store.subscribe(listener);
  localStorage.setItem(PRICING_KEY, JSON.stringify(value()));
  window.dispatchEvent(new StorageEvent("storage", { key: "other" }));
  expect(store.getSnapshot().preferences.selected_id).toBeNull();
  window.dispatchEvent(new StorageEvent("storage", { key: PRICING_KEY }));
  expect(store.getSnapshot().preferences.selected_id).toBe("one");
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  expect(store.getSnapshot().preferences.selected_id).toBeNull();
  stop();
  localStorage.setItem(PRICING_KEY, JSON.stringify(value()));
  const again = store.subscribe(listener);
  expect(store.getSnapshot().preferences.selected_id).toBe("one");
  again();
});
it("server snapshot is stable and never reads browser storage", async () => {
  const adapter = vi.fn(() => localStorage);
  const store = createPricingStore(adapter);
  expect(store.getServerSnapshot()).toBe(store.getServerSnapshot());
  expect(store.getSnapshot()).toBe(store.getSnapshot());
  expect(adapter).not.toHaveBeenCalled();
});

it("rejects invalid edits without changing a saved record", async () => {
  const store = createPricingStore(() => localStorage);
  await store.save(scenario);
  const raw = localStorage.getItem(PRICING_KEY);
  expect(
    await store.save({
      ...scenario,
      standard: { ...scenario.standard, input: Infinity },
    }),
  ).toBe(false);
  expect(await store.rename("one", " ")).toBe(false);
  expect(await store.select("missing")).toBe(false);
  expect(store.getSnapshot().status).toMatch(/changed in another tab/);
  expect(localStorage.getItem(PRICING_KEY)).toBe(raw);
});

it("serializes delayed-event tab saves without losing unrelated scenarios", async () => {
  const first = createPricingStore(() => localStorage);
  const second = createPricingStore(() => localStorage);
  first.subscribe(() => {});
  second.subscribe(() => {});
  expect(
    await Promise.all([
      first.save(scenario),
      second.save({ ...scenario, id: "two", name: "Second" }),
    ]),
  ).toEqual([true, true]);
  expect(JSON.parse(localStorage.getItem(PRICING_KEY) ?? "{}").scenarios).toHaveLength(
    2,
  );
  // Neither store receives a storage event before this next update.
  expect(await first.rename("one", "Updated")).toBe(true);
  expect(JSON.parse(localStorage.getItem(PRICING_KEY) ?? "{}").scenarios).toHaveLength(
    2,
  );
});

it("clear wins over queued stale selection, tier, save, rename and delete without resurrection", async () => {
  const first = createPricingStore(() => localStorage);
  await first.save(scenario);
  const second = createPricingStore(() => localStorage);
  second.subscribe(() => {});
  const clear = first.reset();
  const select = second.select("one", "longContext");
  expect(await clear).toBe(true);
  expect(await select).toBe(false);
  expect(await second.save({ ...scenario, name: "Stale" }, scenario)).toBe(false);
  expect(await second.rename("one", "Stale")).toBe(false);
  expect(await second.remove("one", scenario)).toBe(false);
  expect(JSON.parse(localStorage.getItem(PRICING_KEY) ?? "{}").scenarios).toEqual([]);
  expect(second.getSnapshot().status).toMatch(/changed in another tab/);
});

it("rejects stale same-scenario updates and deletes while preserving latest data", async () => {
  const first = createPricingStore(() => localStorage);
  await first.save(scenario);
  const second = createPricingStore(() => localStorage);
  second.subscribe(() => {});
  await first.rename("one", "Latest");
  expect(await second.save({ ...scenario, name: "Stale" })).toBe(false);
  expect(await second.remove("one", scenario)).toBe(false);
  expect(JSON.parse(localStorage.getItem(PRICING_KEY) ?? "{}").scenarios[0].name).toBe(
    "Latest",
  );
});

it("validates storage inside the lock and fails explicitly without Web Locks", async () => {
  const store = createPricingStore(() => localStorage);
  store.subscribe(() => {});
  localStorage.setItem(PRICING_KEY, "{}");
  expect(await store.save(scenario)).toBe(false);
  expect(localStorage.getItem(PRICING_KEY)).toBe("{}");
  const unsupported = createPricingStore(
    () => localStorage,
    () => undefined,
  );
  expect(await unsupported.reset()).toBe(false);
  expect(unsupported.getSnapshot().status).toMatch(/Web Locks unavailable/);
  expect(unsupported.getSnapshot().pending).toBe(false);
  expect(localStorage.getItem(PRICING_KEY)).toBe("{}");
});

it("fails pending duplicate operations and lock denial visibly", async () => {
  let release: (() => void) | undefined;
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_name: string, operation: () => unknown) =>
        new Promise((resolve) => {
          release = () => resolve(operation());
        }),
    },
  });
  const store = createPricingStore(() => localStorage);
  const pending = store.save(scenario);
  expect(await store.reset()).toBe(false);
  expect(store.getSnapshot().status).toMatch(/already pending/);
  release?.();
  expect(await pending).toBe(true);
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: () => Promise.reject(new Error("denied")),
    },
  });
  expect(await store.reset()).toBe(false);
  expect(store.getSnapshot().status).toMatch(/locking unavailable/);
  expect(store.getSnapshot().preferences.scenarios).toEqual([scenario]);
});

it("selection-only operations preserve the latest tier before delayed storage events", async () => {
  const first = createPricingStore(() => localStorage);
  await first.save(scenario);
  await first.save({ ...scenario, id: "two" });
  const second = createPricingStore(() => localStorage);
  second.subscribe(() => {});
  await first.select("one", "longContext");
  expect(await second.select("two")).toBe(true);
  expect(second.getSnapshot().preferences.tier).toBe("longContext");
});
