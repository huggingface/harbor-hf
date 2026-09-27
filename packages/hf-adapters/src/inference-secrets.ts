import {
  InferenceBindingDenied,
  validateHarborJobConfig,
  type RunRecordV1,
} from "@harbor-hf/contracts";
import type { InferenceBindings } from "@harbor-hf/control-core";

export interface ReviewedVerifierGrant {
  ref: string;
  worker_image: string;
  benchmark: { name: string; preset: string };
  dataset_repo: string;
  dataset_path: string;
  model: string;
  base_url: string;
}

/** Ephemeral delivery boundary. No environment enumeration, serialization or HF token path.
 * The Jobs adapter supplies the transport; runtime derives reviewed policy from the private registry.
 */
export async function withSelectedInferenceSecret<T>(
  run: RunRecordV1,
  image: string,
  policy: () => InferenceBindings | Promise<InferenceBindings>,
  readSelected: (source: string) => string | undefined,
  deliver: (
    secrets: Readonly<Record<string, string>>,
    environment: Readonly<Record<string, string>>,
  ) => Promise<T>,
  verifierGrants: readonly ReviewedVerifierGrant[] = [],
): Promise<T> {
  let selected: ReturnType<InferenceBindings["selected"]>;
  let verifierSource: string | null = null;
  let verifierGrant: ReviewedVerifierGrant | undefined;
  try {
    const reviewed = await policy();
    selected = reviewed.selected(run.harbor_job_config, run.submitted_by, image);
    verifierGrant = verifierGrants.find(
      (grant) =>
        grant.benchmark.name === run.submission?.benchmark?.name &&
        grant.benchmark.preset === run.submission?.benchmark?.preset,
    );
    if (verifierGrant) {
      const config = validateHarborJobConfig(run.harbor_job_config);
      const datasets = config.datasets ?? [];
      if (
        verifierGrant.worker_image !== image ||
        datasets.length !== 1 ||
        datasets[0]?.repo !== verifierGrant.dataset_repo ||
        datasets[0]?.path !== verifierGrant.dataset_path ||
        Object.keys(config.verifier?.env ?? {}).length !== 0 ||
        !selected ||
        selected.ref === verifierGrant.ref
      )
        throw new InferenceBindingDenied();
      verifierSource = reviewed.reviewedSource(verifierGrant.ref, run.submitted_by);
      if (!verifierSource) throw new InferenceBindingDenied();
    }
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
  const verifierEnvironment: Record<string, string> = {};
  try {
    if (verifierGrant && verifierSource) {
      let value: string | undefined;
      try {
        value = readSelected(verifierSource);
      } catch {
        throw new InferenceBindingDenied();
      }
      if (typeof value !== "string" || !value || value === secrets[selected?.ref ?? ""])
        throw new InferenceBindingDenied();
      secrets.AGENT_JUDGE_API_KEY = value;
      verifierEnvironment.AGENT_JUDGE_API_URL = verifierGrant.base_url;
      verifierEnvironment.AGENT_JUDGE_MODEL = verifierGrant.model;
    }
    try {
      return await deliver(secrets, verifierEnvironment);
    } catch {
      // Never return transport errors that may contain ephemeral secret arguments.
      throw new Error("Reviewed inference delivery failed");
    }
  } finally {
    for (const key of Object.keys(secrets)) delete secrets[key];
  }
}
