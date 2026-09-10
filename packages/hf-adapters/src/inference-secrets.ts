import { InferenceBindingDenied, type RunRecordV1 } from "@harbor-hf/contracts";
import type { InferenceBindings } from "@harbor-hf/control-core";

/** Ephemeral delivery boundary. No environment enumeration, serialization or HF token path.
 * The Jobs adapter supplies the transport; runtime derives reviewed policy from the private registry.
 */
export async function withSelectedInferenceSecret<T>(
  run: RunRecordV1,
  image: string,
  policy: () => InferenceBindings | Promise<InferenceBindings>,
  readSelected: (source: string) => string | undefined,
  deliver: (secrets: Readonly<Record<string, string>>) => Promise<T>,
): Promise<T> {
  let selected: ReturnType<InferenceBindings["selected"]>;
  try {
    selected = (await policy()).selected(
      run.harbor_job_config,
      run.submitted_by,
      image,
    );
  } catch {
    // This check precedes delivery, so callers can safely block just this start.
    throw new InferenceBindingDenied();
  }
  const secrets: Record<string, string> = {};
  if (selected) {
    let value: string | undefined;
    try {
      value = readSelected(selected.source);
    } catch {
      throw new InferenceBindingDenied("Inference credential presence is unavailable");
    }
    if (typeof value !== "string" || value.length === 0)
      throw new InferenceBindingDenied("Selected inference credential is missing");
    secrets[selected.ref] = value;
  }
  try {
    return await deliver(secrets);
  } catch {
    // Never return transport errors that may contain ephemeral secret arguments.
    throw new Error("Reviewed inference delivery failed");
  } finally {
    for (const key of Object.keys(secrets)) delete secrets[key];
  }
}
