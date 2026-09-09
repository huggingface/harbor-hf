import type { BrowserPricingV1 } from "@harbor-hf/contracts";
import { useSyncExternalStore } from "react";
import validate from "./generated/browser-pricing-validator.js";

export type SavedScenario = BrowserPricingV1["scenarios"][number];
export const PRICING_KEY = "harbor-hf.browser-pricing.v1";
export function validPreferences(value: unknown): value is BrowserPricingV1 {
  if (!validate(value)) return false;
  const ids = new Set(value.scenarios.map((scenario) => scenario.id));
  return (
    ids.size === value.scenarios.length &&
    (value.selected_id === null || ids.has(value.selected_id))
  );
}
const empty: BrowserPricingV1 = {
  schema_version: "v1",
  scenarios: [],
  selected_id: null,
  tier: "standard",
};
const initial = { preferences: empty, status: "", blocked: false, pending: false };
type Snapshot = typeof initial;

// Lazy browser adapter; getSnapshot never allocates or writes. Also usable in SSR.
export function createPricingStore(
  storage: () => Storage,
  locks: () => Pick<LockManager, "request"> | undefined = () =>
    globalThis.navigator?.locks,
) {
  let snapshot: Snapshot = initial;
  let loaded = false;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const read = () => {
    loaded = true;
    try {
      const raw = storage().getItem(PRICING_KEY);
      const value: unknown =
        raw === null ? empty : raw.length > 65536 ? null : JSON.parse(raw);
      snapshot = validPreferences(value)
        ? { preferences: value, status: "", blocked: false, pending: snapshot.pending }
        : {
            preferences: empty,
            status: "Invalid saved pricing ignored. Reset to save again.",
            blocked: true,
            pending: snapshot.pending,
          };
    } catch {
      snapshot = {
        preferences: snapshot.preferences,
        status: "Saved pricing could not be read. Reset to try again.",
        blocked: true,
        pending: snapshot.pending,
      };
    }
    emit();
  };
  const fail = (status: string) => {
    snapshot = { ...snapshot, status };
    emit();
    return false;
  };
  // All cooperating tabs use the same exclusive origin-scoped lock. Never fall
  // back to an unlocked read/write: storage events are notifications, not locks.
  const commit = async (
    update: (current: BrowserPricingV1) => BrowserPricingV1 | null,
    reset = false,
  ): Promise<boolean> => {
    if (snapshot.pending)
      return fail("Pricing operation already pending. Wait before trying again.");
    snapshot = { ...snapshot, pending: true };
    emit();
    try {
      const manager = locks();
      if (!manager)
        return fail("Pricing not saved: Web Locks unavailable in this browser.");
      return await manager.request(PRICING_KEY, () => {
        read();
        if (snapshot.blocked && !reset) return false;
        const preferences = update(snapshot.preferences);
        if (!preferences)
          return fail(
            "Pricing changed in another tab. Reload saved values before trying again.",
          );
        if (!validPreferences(preferences)) {
          return fail("Invalid scenario: check name, rates and threshold.");
        }
        try {
          storage().setItem(PRICING_KEY, JSON.stringify(preferences));
          snapshot = { preferences, status: "", blocked: false, pending: true };
          emit();
          return true;
        } catch {
          return fail("Pricing not saved: browser storage unavailable or full.");
        }
      });
    } catch {
      return fail("Pricing not saved: browser locking unavailable.");
    } finally {
      snapshot = { ...snapshot, pending: false };
      emit();
    }
  };
  const current = () => {
    if (!loaded) read();
    return snapshot.preferences;
  };
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initial,
    subscribe: (listener: () => void) => {
      const first = listeners.size === 0;
      listeners.add(listener);
      if (first) read();
      const sync = (event: StorageEvent) => {
        if (event.key === PRICING_KEY || event.key === null) read();
      };
      if (typeof window !== "undefined") window.addEventListener("storage", sync);
      return () => {
        listeners.delete(listener);
        if (typeof window !== "undefined") window.removeEventListener("storage", sync);
      };
    },
    save: async (
      draft: Omit<SavedScenario, "id"> & { id?: string | undefined },
      expected = current().scenarios.find((item) => item.id === draft.id),
    ) => {
      let scenario: SavedScenario;
      try {
        scenario = { ...draft, id: draft.id ?? globalThis.crypto.randomUUID() };
      } catch {
        return fail(
          "Pricing not saved: secure ID generation unavailable in this browser.",
        );
      }
      return commit((latest) =>
        sameScenario(
          latest.scenarios.find((item) => item.id === scenario.id),
          expected,
        )
          ? {
              ...latest,
              scenarios: [
                ...latest.scenarios.filter((item) => item.id !== scenario.id),
                scenario,
              ],
              selected_id: scenario.id,
            }
          : null,
      );
    },
    select: (selected_id: string | null, tier?: BrowserPricingV1["tier"]) => {
      const expected = current().scenarios.find((item) => item.id === selected_id);
      return commit((latest) =>
        selected_id !== null &&
        (!expected ||
          !sameScenario(
            latest.scenarios.find((item) => item.id === selected_id),
            expected,
          ))
          ? null
          : { ...latest, selected_id, tier: tier ?? latest.tier },
      );
    },
    rename: (id: string, name: string) => {
      const expected = current().scenarios.find((item) => item.id === id);
      return commit((latest) =>
        !expected ||
        !sameScenario(
          latest.scenarios.find((item) => item.id === id),
          expected,
        )
          ? null
          : {
              ...latest,
              scenarios: latest.scenarios.map((item) =>
                item.id === id ? { ...item, name: name.trim() } : item,
              ),
            },
      );
    },
    remove: (
      id: string,
      expected = current().scenarios.find((item) => item.id === id),
    ) =>
      commit((latest) =>
        !expected ||
        !sameScenario(
          latest.scenarios.find((item) => item.id === id),
          expected,
        )
          ? null
          : {
              ...latest,
              scenarios: latest.scenarios.filter((item) => item.id !== id),
              selected_id: latest.selected_id === id ? null : latest.selected_id,
            },
      ),
    reset: () => commit(() => empty, true),
  };
}
export function sameScenario(
  left: SavedScenario | undefined,
  right: SavedScenario | undefined,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}
export const pricingStore = createPricingStore(() => window.localStorage);
export function usePricingPreferences() {
  return useSyncExternalStore(
    pricingStore.subscribe,
    pricingStore.getSnapshot,
    pricingStore.getServerSnapshot,
  );
}
export function activeScenario(preferences: BrowserPricingV1) {
  return preferences.scenarios.find((item) => item.id === preferences.selected_id);
}
