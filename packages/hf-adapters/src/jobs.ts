import { assertRunId, type RunRecordV1 } from "@harbor-hf/contracts";
import type {
  InferenceBindings,
  JobObservation,
  JobsPort,
} from "@harbor-hf/control-core";
import { cancelJob, runJob, type SpaceHardwareFlavor } from "@huggingface/hub";

import { inspectJob, listJobPages, observation } from "./jobs-read.js";

import { withSelectedInferenceSecret } from "./inference-secrets.js";

export type ParentHardware = SpaceHardwareFlavor;

const ROLE_LABEL = "harbor-hf-role";
const RUN_LABEL = "harbor-hf-run";
const IMMUTABLE_IMAGE = /@sha256:[0-9a-f]{64}$/;

export interface ReadOnlyHuggingFaceJobsOptions {
  namespace: string;
  accessToken: string;
  hubUrl?: string;
  fetch?: typeof fetch;
}

export interface HuggingFaceJobsOptions extends ReadOnlyHuggingFaceJobsOptions {
  inferenceToken: string;
  bucketId: string;
  parentImage: string;
  hardware?: SpaceHardwareFlavor;
  mountRoot?: string;
  timeoutSeconds?: number;
}

export class ReadOnlyHuggingFaceJobs implements JobsPort {
  constructor(private readonly options: ReadOnlyHuggingFaceJobsOptions) {}

  async list(): Promise<readonly JobObservation[]> {
    return listJobPages(this.options);
  }

  async inspect(jobId: string): Promise<JobObservation> {
    return inspectJob(this.options, jobId);
  }

  async startParent(_runId: string): Promise<JobObservation> {
    throw new Error("Job launch is disabled");
  }

  async cancel(_jobId: string): Promise<void> {
    throw new Error("Job cancellation is disabled");
  }
}

export class HuggingFaceJobs implements JobsPort {
  private readonly hardware: SpaceHardwareFlavor;
  private readonly mountRoot: string;
  private readonly timeoutSeconds: number;

  constructor(private readonly options: HuggingFaceJobsOptions) {
    if (!IMMUTABLE_IMAGE.test(options.parentImage))
      throw new Error("parent image must use an immutable sha256 digest");
    this.options = Object.freeze({ ...options });
    this.hardware = options.hardware ?? "cpu-basic";
    this.mountRoot = options.mountRoot ?? "/data";
    this.timeoutSeconds = options.timeoutSeconds ?? 86_400;
  }

  private credentials(): {
    namespace: string;
    accessToken: string;
    hubUrl?: string;
    fetch?: typeof fetch;
  } {
    return {
      namespace: this.options.namespace,
      accessToken: this.options.accessToken,
      ...(this.options.hubUrl ? { hubUrl: this.options.hubUrl } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    };
  }

  async list(): Promise<readonly JobObservation[]> {
    return listJobPages(this.options);
  }

  async inspect(jobId: string): Promise<JobObservation> {
    return inspectJob(this.options, jobId);
  }

  async startParent(runId: string): Promise<JobObservation> {
    return this.#startParent(runId, {
      HF_INFERENCE_TOKEN: this.options.inferenceToken,
    });
  }

  async startReviewedParent(
    run: RunRecordV1,
    policy: () => InferenceBindings | Promise<InferenceBindings>,
    readSelected: (source: string) => string | undefined,
  ): Promise<JobObservation> {
    return withSelectedInferenceSecret(
      run,
      this.options.parentImage,
      policy,
      readSelected,
      (secrets) => this.#startParent(run.run_id, secrets),
    );
  }

  // Only legacy HF delivery and the reviewed selector can reach this transport.
  async #startParent(
    runId: string,
    inferenceSecrets: Readonly<Record<string, string>>,
  ): Promise<JobObservation> {
    assertRunId(runId);
    const value = await runJob({
      ...this.credentials(),
      dockerImage: this.options.parentImage,
      command: ["python", "-m", "harbor_hf_agents.parent_worker"],
      environment: {
        HARBOR_HF_RUN_ID: runId,
        HARBOR_HF_MOUNT_ROOT: this.mountRoot,
        HARBOR_HF_NAMESPACE: this.options.namespace,
      },
      secrets: {
        HF_TOKEN: this.options.accessToken,
        ...inferenceSecrets,
      },
      flavor: this.hardware,
      arch: "amd64",
      timeoutSeconds: this.timeoutSeconds,
      attempts: 1,
      labels: { [ROLE_LABEL]: "parent", [RUN_LABEL]: runId },
      volumes: [
        {
          source: { type: "bucket", name: this.options.bucketId },
          mountPath: this.mountRoot,
          readOnly: false,
        },
      ],
    });
    const result = observation(value);
    if (!result) throw new Error("created parent Job has invalid metadata");
    return result;
  }

  async cancel(jobId: string): Promise<void> {
    await cancelJob({ ...this.credentials(), jobId });
  }
}

export class NoopJobs implements JobsPort {
  async list(): Promise<readonly JobObservation[]> {
    return [];
  }

  async inspect(_jobId: string): Promise<JobObservation> {
    throw new Error("Job inspection is unavailable");
  }

  async startParent(_runId: string): Promise<JobObservation> {
    throw new Error("Job launch is disabled");
  }

  async cancel(_jobId: string): Promise<void> {}
}
