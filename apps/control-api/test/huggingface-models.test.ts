import { afterEach, expect, it, vi } from "vitest";
import { lookupHuggingFaceModelProviders } from "../src/huggingface-models.js";

afterEach(() => vi.unstubAllGlobals());
it("propagates the inspection deadline to the real provider request", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (_url, options) => {
      requestSignal = options?.signal;
      controller.abort();
      requestSignal?.throwIfAborted();
      return Response.json({});
    }),
  );
  await expect(
    lookupHuggingFaceModelProviders("example/model", controller.signal),
  ).rejects.toThrow("could not be reached");
  expect(requestSignal?.aborted).toBe(true);
});
