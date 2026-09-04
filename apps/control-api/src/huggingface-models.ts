import { z } from "zod";

const hubModelResponse = z
  .object({
    id: z.string(),
    inferenceProviderMapping: z.record(
      z.string().min(1),
      z.object({ status: z.string() }).passthrough(),
    ),
  })
  .passthrough();

export class HuggingFaceModelNotFoundError extends Error {
  constructor(model: string) {
    super(`model "${model}" was not found on the Hugging Face Hub`);
    this.name = "HuggingFaceModelNotFoundError";
  }
}

export class HuggingFaceModelLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HuggingFaceModelLookupError";
  }
}

function modelUrl(model: string): string {
  const path = model.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`https://huggingface.co/api/models/${path}`);
  url.searchParams.set("expand[]", "inferenceProviderMapping");
  return url.toString();
}

export async function lookupHuggingFaceModelProviders(
  model: string,
): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(modelUrl(model), {
      headers: {
        Accept: "application/json",
        "User-Agent": "harbor-hf-control/0.1",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HuggingFaceModelLookupError("the Hugging Face Hub could not be reached");
  }

  if (response.status === 404) throw new HuggingFaceModelNotFoundError(model);
  if (!response.ok)
    throw new HuggingFaceModelLookupError(
      `the Hugging Face Hub returned HTTP ${response.status} while looking up model providers`,
    );

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new HuggingFaceModelLookupError(
      "the Hugging Face Hub returned invalid JSON for this model",
    );
  }
  const parsed = hubModelResponse.safeParse(body);
  if (!parsed.success)
    throw new HuggingFaceModelLookupError(
      "the Hugging Face Hub returned an invalid provider mapping for this model",
    );

  return Object.entries(parsed.data.inferenceProviderMapping)
    .filter(([, provider]) => provider.status === "live")
    .map(([provider]) => provider)
    .sort();
}
