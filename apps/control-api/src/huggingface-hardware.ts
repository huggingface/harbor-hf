import { z } from "zod";

// Preserve the public HF Jobs catalog fields. Specifications and prices are
// observations for the UI, not another hardware registry or durable run state.
export const hardwareSchema = z.object({
  name: z.string().min(1),
  prettyName: z.string().min(1),
  cpu: z.string(),
  ram: z.string(),
  ephemeralStorage: z.string(),
  accelerator: z
    .object({
      quantity: z.string().regex(/^[1-9][0-9]*$/),
      model: z.string(),
      vram: z.string(),
    })
    .nullable(),
  unitCostMicroUSD: z.number().int().nonnegative().nullable().optional(),
  unitCostUSD: z.number().nonnegative().nullable().optional(),
  unitLabel: z.string().min(1),
});
export const hardwareCatalogSchema = z.array(hardwareSchema).min(1);

export class HuggingFaceHardwareLookupError extends Error {
  constructor() {
    super("The Hugging Face hardware catalog is unavailable; try again shortly");
    this.name = "HuggingFaceHardwareLookupError";
  }
}

export async function lookupHuggingFaceHardware(): Promise<
  z.infer<typeof hardwareCatalogSchema>
> {
  try {
    const response = await fetch("https://huggingface.co/api/jobs/hardware", {
      headers: { Accept: "application/json", "User-Agent": "harbor-hf-control/0.1" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new HuggingFaceHardwareLookupError();
    return hardwareCatalogSchema.parse(await response.json());
  } catch {
    throw new HuggingFaceHardwareLookupError();
  }
}
