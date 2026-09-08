import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupHuggingFaceHardware } from "../src/huggingface-hardware.js";

const hardware = {
  name: "a100-large",
  prettyName: "A100",
  cpu: "12 vCPU",
  ram: "142 GB",
  ephemeralStorage: "1000 GB",
  accelerator: { quantity: "1", model: "A100", vram: "80 GB" },
  unitCostMicroUSD: 41667,
  unitCostUSD: 0.041667,
  unitLabel: "minute",
};
afterEach(() => vi.unstubAllGlobals());
describe("HF hardware catalog", () => {
  it("preserves provider fields and reads the official endpoint without credentials", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json([hardware]));
    vi.stubGlobal("fetch", fetcher);
    expect(await lookupHuggingFaceHardware()).toEqual([hardware]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://huggingface.co/api/jobs/hardware",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("headers.Authorization");
  });
  it.each([1, "0", "-1", "1.5", "many"])(
    "rejects an invalid provider quantity: %s",
    async (quantity) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json([
            { ...hardware, accelerator: { ...hardware.accelerator, quantity } },
          ]),
        ),
      );
      await expect(lookupHuggingFaceHardware()).rejects.toThrow(
        "hardware catalog is unavailable",
      );
    },
  );
  it("preserves unknown prices instead of reporting free hardware", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json([{ ...hardware, accelerator: null, unitCostUSD: null }]),
      ),
    );
    expect((await lookupHuggingFaceHardware())[0]?.unitCostUSD).toBeNull();
  });
  it.each([
    () => Promise.reject(new Error("private transport error")),
    () => Promise.resolve(new Response("private response", { status: 503 })),
    () => Promise.resolve(new Response("not-json")),
    () => Promise.resolve(Response.json([])),
    () => Promise.resolve(Response.json([{ ...hardware, unitCostUSD: -1 }])),
    () => Promise.resolve(Response.json([{ name: "incomplete" }])),
  ])("fails safely when the catalog cannot be used", async (response) => {
    vi.stubGlobal("fetch", vi.fn(response));
    await expect(lookupHuggingFaceHardware()).rejects.toThrow(
      "hardware catalog is unavailable",
    );
  });
});
