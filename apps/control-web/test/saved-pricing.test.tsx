// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useMemo } from "react";
import { renderToString } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunView } from "../src/api";
import { DataTable } from "../src/components/data-table";
import { PricingPanel } from "../src/pricing-panel";
import {
  PricingSelection,
  scenarioCostColumn,
  scenarioRows,
} from "../src/pricing-selection";
import { pricingStore, PRICING_KEY, usePricingPreferences } from "../src/pricing-store";
const result = {
  stats: {
    n_input_tokens: 1000000,
    n_cache_tokens: 250000,
    n_output_tokens: 100000,
    cost_usd: 77,
  },
};
beforeEach(async () => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (_name: string, operation: () => unknown) => operation(),
    },
  });
  await pricingStore.reset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function edit(label: string, value: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  });
}
async function save(name: string) {
  await edit("Scenario name", name);
  for (const [label, rate] of [
    ["Standard input", "2"],
    ["Standard output", "8"],
    ["Standard cached", "0.5"],
    ["Long-context input", "4"],
    ["Long-context output", "16"],
    ["Long-context cached", "1"],
  ])
    await edit(`${label} (USD/M)`, rate ?? "");
  await act(async () => {
    fireEvent.click(screen.getByText("Save & Use"));
  });
}
it("explicit save, rename, new, selection and deletion share estimates without API writes", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("No API expected"));
  const view = render(<PricingPanel result={result} />);
  await act(async () => {
    fireEvent.click(screen.getByText(/Pricing scenarios ·/));
  });
  await save("First");
  expect(screen.getByLabelText("Scenario estimate USD: 2.425")).toBeInTheDocument();
  await edit("Standard input (USD/M)", "20");
  expect(screen.getByLabelText("Scenario estimate USD: 2.425")).toBeInTheDocument();
  view.rerender(<PricingPanel result={{ ...result }} />);
  expect(screen.getByLabelText("Standard input (USD/M)")).toHaveValue(20);
  await edit("Scenario tier", "longContext");
  expect(screen.getByLabelText("Scenario estimate USD: 4.85")).toBeInTheDocument();
  await edit("Scenario name", "Renamed");
  await act(async () => {
    fireEvent.click(screen.getByText("Save & Use"));
  });
  expect(screen.getByRole("option", { name: "Renamed" })).toBeInTheDocument();
  const first = pricingStore.getSnapshot().preferences.selected_id;
  await act(async () => {
    fireEvent.click(screen.getByText("New scenario"));
  });
  expect(screen.getByLabelText("Standard input (USD/M)")).toHaveValue(null);
  await save("Second");
  await edit("Saved scenario", first ?? "");
  expect(screen.getByLabelText("Scenario name")).toHaveValue("Renamed");
  view.unmount();
  render(<PricingPanel result={result} />);
  await act(async () => {
    fireEvent.click(screen.getByText(/Pricing scenarios ·/));
  });
  expect(screen.getByLabelText("Standard input (USD/M)")).toHaveValue(20);
  await act(async () => {
    fireEvent.click(screen.getByText("Delete scenario"));
  });
  expect(
    screen.getByLabelText("Scenario estimate USD: unavailable"),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Standard input (USD/M)")).toHaveValue(null);
  expect(fetch).not.toHaveBeenCalled();
  expect(result.stats.cost_usd).toBe(77);
});
it("blank rates stay null, zero is valid, failed saves keep drafts and do not claim success", async () => {
  render(<PricingPanel result={result} />);
  await act(async () => {
    fireEvent.click(screen.getByText(/Pricing scenarios ·/));
  });
  await act(async () => {
    fireEvent.click(screen.getByText("Clear saved pricing"));
  });
  await edit("Scenario name", "Unset");
  await act(async () => {
    fireEvent.click(screen.getByText("Save & Use"));
  });
  expect(
    pricingStore.getSnapshot().preferences.scenarios[0]?.standard.input,
  ).toBeNull();
  expect(
    screen.getByLabelText("Scenario estimate USD: unavailable"),
  ).toBeInTheDocument();
  for (const label of ["Standard input", "Standard output", "Standard cached"])
    await edit(`${label} (USD/M)`, "0");
  await act(async () => {
    fireEvent.click(screen.getByText("Save & Use"));
  });
  expect(screen.getByLabelText("Scenario estimate USD: 0")).toBeInTheDocument();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  await edit("Standard input (USD/M)", "3");
  await act(async () => {
    fireEvent.click(screen.getByText("Save & Use"));
  });
  expect(
    screen.getByRole("status", { name: "Pricing storage status" }),
  ).toHaveTextContent(/not saved/);
  expect(screen.getByLabelText("Standard input (USD/M)")).toHaveValue(3);
  await act(async () => {
    fireEvent.click(screen.getByText("New scenario"));
  });
  expect(screen.getByLabelText("Standard input (USD/M)")).toHaveValue(3);
  expect(screen.getByLabelText("Scenario estimate USD: 0")).toBeInTheDocument();
});
it("external storage sync updates controls and malformed content needs explicit reset", async () => {
  render(<PricingPanel result={result} />);
  await act(async () => {
    fireEvent.click(screen.getByText(/Pricing scenarios ·/));
  });
  await save("Sync");
  await act(async () => {
    localStorage.setItem(PRICING_KEY, "{}");
    window.dispatchEvent(new StorageEvent("storage", { key: PRICING_KEY }));
  });
  expect(screen.getByLabelText("Saved scenario")).toBeDisabled();
  expect(
    screen.getByRole("status", { name: "Pricing storage status" }),
  ).toHaveTextContent(/Invalid/);
  expect(localStorage.getItem(PRICING_KEY)).toBe("{}");
  await act(async () => {
    fireEvent.click(screen.getByText("Reset saved pricing"));
  });
  expect(screen.getByLabelText("Saved scenario")).not.toBeDisabled();
});
it("numeric sorting recomputes on tier/scenario change with missing values last both ways", async () => {
  const run = (id: string, input: number | null, output: number | null) =>
    ({
      record: { run_id: id },
      result: {
        stats: { n_input_tokens: input, n_output_tokens: output, n_cache_tokens: 0 },
      },
    }) as RunView;
  const runs = [
    run("small", 1000000, 0),
    run("large", 0, 1000000),
    run("zero", 0, 0),
    run("missing", null, 2),
  ];
  await pricingStore.save({
    id: "sort",
    name: "Sort",
    threshold: 1,
    standard: { input: 2.00001, output: 2.00002, cached: 0 },
    longContext: { input: 20, output: 1, cached: 0 },
  });
  function List() {
    const { preferences } = usePricingPreferences();
    const rows = useMemo(() => scenarioRows(runs, preferences), [preferences]);
    return (
      <>
        <PricingSelection />
        <DataTable
          columns={[
            { accessorFn: (row) => row.record.run_id, id: "name" },
            scenarioCostColumn(),
          ]}
          data={rows}
        />
      </>
    );
  }
  const view = render(<List />);
  const order = () =>
    [...view.container.querySelectorAll("tbody tr")].map(
      (row) => row.querySelector("td")?.textContent,
    );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Scenario estimate" }));
  });
  // Numeric columns default to descending.
  expect(order()).toEqual(["large", "small", "zero", "missing"]);
  await edit("Scenario tier", "longContext");
  expect(order()).toEqual(["small", "large", "zero", "missing"]);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Scenario estimate" }));
  });
  expect(order()).toEqual(["zero", "large", "small", "missing"]);
  await act(async () => {
    await pricingStore.save({
      id: "other",
      name: "Other",
      threshold: 272000,
      standard: { input: 1, output: 2, cached: 0 },
      longContext: { input: 1, output: 2, cached: 0 },
    });
  });
  expect(order()).toEqual(["zero", "small", "large", "missing"]);
});

it("renders a stable empty server snapshot without accessing localStorage", async () => {
  const read = vi.spyOn(Storage.prototype, "getItem");
  expect(renderToString(<PricingSelection />)).toContain("Saved in this browser");
  expect(read).not.toHaveBeenCalled();
});

it("retains complete new drafts across route unmounts without persisting them", async () => {
  let view = render(<PricingPanel result={result} />);
  await act(async () => {
    fireEvent.click(screen.getByText("Clear saved pricing"));
  });
  await edit("Scenario name", "Unfinished name");
  await edit("Standard input (USD/M)", "17");
  await act(async () => {
    fireEvent.change(screen.getByLabelText(/Long context when request input exceeds/), {
      target: { value: "123" },
    });
  });
  const raw = localStorage.getItem(PRICING_KEY);
  expect(raw).not.toContain("Unfinished name");
  view.unmount();
  view = render(<PricingPanel result={result} />);
  expect(screen.getByLabelText("Scenario name")).toHaveValue("Unfinished name");
  expect(screen.getByLabelText("Standard input (USD/M)")).toHaveValue(17);
  expect(screen.getByLabelText(/Long context when request input exceeds/)).toHaveValue(
    123,
  );
  expect(localStorage.getItem(PRICING_KEY)).toBe(raw);
  view.unmount();
});

it("retains dirty rates on external rename and requires explicit reload", async () => {
  render(<PricingPanel result={result} />);
  await save("Original");
  await edit("Standard input (USD/M)", "99");
  const updated = structuredClone(pricingStore.getSnapshot().preferences);
  const scenario = updated.scenarios[0];
  if (!scenario) throw new Error("missing fixture");
  scenario.name = "External rename";
  await act(async () => {
    localStorage.setItem(PRICING_KEY, JSON.stringify(updated));
    window.dispatchEvent(new StorageEvent("storage", { key: PRICING_KEY }));
  });
  expect(screen.getByLabelText("Standard input (USD/M)")).toHaveValue(99);
  expect(screen.getByLabelText("Scenario name")).toHaveValue("Original");
  expect(screen.getByRole("alert")).toHaveTextContent(/draft is retained/);
  expect(screen.getByText("Save & Use")).toBeDisabled();
  await act(async () => {
    fireEvent.click(screen.getByText("Reload saved values"));
  });
  expect(screen.getByLabelText("Scenario name")).toHaveValue("External rename");
  expect(screen.getByLabelText("Standard input (USD/M)")).toHaveValue(2);
});

it("disables editors and selectors while awaiting the native lock", async () => {
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
  render(<PricingPanel result={result} />);
  await edit("Scenario name", "Pending");
  await act(async () => {
    fireEvent.click(screen.getByText("Save & Use"));
  });
  expect(screen.getByLabelText("Scenario name")).toBeDisabled();
  expect(screen.getByLabelText("Saved scenario")).toBeDisabled();
  expect(screen.getByText("Save & Use")).toBeDisabled();
  await act(async () => {
    release?.();
  });
  expect(screen.getByLabelText("Scenario name")).not.toBeDisabled();
});

it("external clearing retains dirty editor content without resurrecting the deleted ID", async () => {
  render(<PricingPanel result={result} />);
  await save("Deleted externally");
  await edit("Standard input (USD/M)", "23");
  await act(async () => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });
  expect(screen.getByLabelText("Standard input (USD/M)")).toHaveValue(23);
  expect(screen.getByRole("alert")).toHaveTextContent(/draft is retained/);
  expect(screen.getByText("Save & Use")).toBeDisabled();
  expect(pricingStore.getSnapshot().preferences.scenarios).toEqual([]);
  await act(async () => {
    fireEvent.click(screen.getByText("Reload saved values"));
  });
  expect(screen.getByLabelText("Scenario name")).toHaveValue("");
  expect(screen.getByLabelText("Standard input (USD/M)")).toHaveValue(null);
});

const unavailableCrypto = [
  ["missing crypto", undefined],
  ["missing randomUUID", {}],
  [
    "throwing randomUUID",
    {
      randomUUID: () => {
        throw new Error("unavailable");
      },
    },
  ],
] as const;
for (const locksAvailable of [true, false]) {
  it.each(unavailableCrypto)(
    `fails closed with %s and locks ${locksAvailable}`,
    async (_label, crypto) => {
      render(<PricingPanel result={result} />);
      await act(async () => {
        fireEvent.click(screen.getByText("Clear saved pricing"));
      });
      const raw = localStorage.getItem(PRICING_KEY);
      const write = vi.spyOn(Storage.prototype, "setItem");
      const remove = vi.spyOn(Storage.prototype, "removeItem");
      const clear = vi.spyOn(Storage.prototype, "clear");
      const rejection = vi.fn();
      window.addEventListener("unhandledrejection", rejection);
      try {
        vi.stubGlobal("crypto", crypto);
        if (!locksAvailable)
          Object.defineProperty(navigator, "locks", {
            configurable: true,
            value: undefined,
          });
        await save("Retained draft");
        expect(
          screen.getByRole("status", { name: "Pricing storage status" }),
        ).toHaveTextContent(
          "Pricing not saved: secure ID generation unavailable in this browser.",
        );
        expect(screen.getByLabelText("Scenario name")).toHaveValue("Retained draft");
        expect(screen.getByLabelText("Standard input (USD/M)")).toHaveValue(2);
        expect(screen.getByLabelText("Long-context output (USD/M)")).toHaveValue(16);
        expect(
          screen.getByLabelText("Scenario estimate USD: unavailable"),
        ).toBeInTheDocument();
        expect(
          screen.queryByRole("option", { name: "Retained draft" }),
        ).not.toBeInTheDocument();
        expect(pricingStore.getSnapshot().preferences.scenarios).toEqual([]);
        expect(pricingStore.getSnapshot().pending).toBe(false);
        expect(localStorage.getItem(PRICING_KEY)).toBe(raw);
        expect(write).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(clear).not.toHaveBeenCalled();
        expect(rejection).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener("unhandledrejection", rejection);
      }
    },
  );
}
it.each(unavailableCrypto)("saves an existing ID with %s", async (_label, crypto) => {
  render(<PricingPanel result={result} />);
  await save("Existing");
  const id = pricingStore.getSnapshot().preferences.selected_id;
  vi.stubGlobal("crypto", crypto);
  await save("Updated existing");
  expect(pricingStore.getSnapshot().preferences.selected_id).toBe(id);
  expect(pricingStore.getSnapshot().preferences.scenarios).toHaveLength(1);
  expect(screen.getByRole("option", { name: "Updated existing" })).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(PRICING_KEY) ?? "{}").scenarios[0].name).toBe(
    "Updated existing",
  );
  expect(pricingStore.getSnapshot().status).toBe("");
});
