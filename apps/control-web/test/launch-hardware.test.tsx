// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { hardwarePrice, LaunchHardware } from "../src/launch-hardware";

vi.mock("../src/api", () => ({ api: vi.fn() }));
const cpu = {
  name: "cpu-basic",
  prettyName: "CPU Basic",
  cpu: "2 vCPU",
  ram: "16 GB",
  ephemeralStorage: "50 GB",
  accelerator: null,
  unitCostUSD: 0.000167,
  unitLabel: "minute",
};
const gpu = {
  ...cpu,
  name: "a100-large",
  prettyName: "A100",
  accelerator: { quantity: "1", model: "A100", vram: "80 GB" },
  unitCostUSD: 0.04,
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function show(value = gpu.name) {
  const change = vi.fn();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <LaunchHardware value={value} onChange={change} />
    </QueryClientProvider>,
  );
  return change;
}
describe("HF sandbox hardware choices", () => {
  it("shows provider specifications and hourly prices and preserves native flavor names", async () => {
    vi.mocked(api).mockResolvedValue([cpu, gpu]);
    const change = show();
    await screen.findByText(/80 GB/);
    expect(screen.getByText(/USD 2.40\/hour per sandbox/)).toBeTruthy();
    const picker = screen.getByRole("combobox", { name: "Sandbox flavor" });
    fireEvent.change(picker, { target: { value: "cpu-basic" } });
    expect(change).toHaveBeenCalledWith("cpu-basic");
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/v1/hardware");
  });
  it("keeps unknown selections visible and offers retry instead of silently changing hardware", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("offline"));
    const change = show("missing-flavor");
    await screen.findByText(/HF hardware catalog unavailable/);
    expect(change).not.toHaveBeenCalled();
    vi.mocked(api).mockResolvedValue([cpu]);
    fireEvent.click(screen.getByRole("button", { name: "Retry hardware lookup" }));
    await screen.findByText(/selected flavor is not in the current HF catalog/);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(
      "missing-flavor",
    );
  });
  it("does not turn unknown prices into free hardware or assume every unit is minutes", () => {
    expect(hardwarePrice({ ...cpu, unitCostUSD: null })).toBe("Price unavailable");
    expect(hardwarePrice({ ...cpu, unitCostUSD: undefined })).toBe("Price unavailable");
    expect(hardwarePrice({ ...cpu, unitCostUSD: 0, unitLabel: "hour" })).toBe(
      "USD 0.00/hour",
    );
    expect(hardwarePrice({ ...cpu, unitCostUSD: 0.5, unitLabel: "second" })).toBe(
      "USD 0.50/second",
    );
  });
});
