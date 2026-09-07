import {
  cancelJob,
  getJob,
  listFiles,
  listJobs,
  runJob,
  streamJobLogs,
  whoAmI,
  type SpaceHardwareFlavor,
} from "@huggingface/hub";

/** Request scoped. Never construct this with a control-service credential. */
export class PersonalHuggingFace {
  constructor(
    private readonly accessToken: string,
    private readonly transport: typeof fetch = fetch,
  ) {}

  private options() {
    return {
      accessToken: this.accessToken,
      fetch: ((url, init) =>
        this.transport(url, {
          ...init,
          signal: AbortSignal.any([
            ...(init?.signal ? [init.signal] : []),
            AbortSignal.timeout(30_000),
          ]),
        })) as typeof fetch,
    };
  }

  async identity() {
    const identity = await whoAmI(this.options());
    if (identity.type !== "user") throw new Error("Personal identity required");
    return { id: identity.id, name: identity.name };
  }

  async jobs(owner: string) {
    const jobs = await listJobs({ ...this.options(), namespace: owner });
    // Never return raw JobInfo: it includes environment and secret metadata.
    return jobs.map((job) => ({
      id: job.id,
      stage: String(job.status.stage),
      url: `https://huggingface.co/jobs/${encodeURIComponent(owner)}/${encodeURIComponent(job.id)}`,
      run_id: job.labels?.["harbor-hf-run"] ?? null,
      mode: job.labels?.["harbor-hf-mode"] ?? null,
    }));
  }

  async job(owner: string, jobId: string) {
    const value = await getJob({ ...this.options(), namespace: owner, jobId });
    return { id: value.id, stage: String(value.status.stage) };
  }

  async cancel(owner: string, jobId: string) {
    await getJob({ ...this.options(), namespace: owner, jobId });
    await cancelJob({ ...this.options(), namespace: owner, jobId });
    return { parent_cancel_requested: true, sandbox_cleanup: "unverified" };
  }

  async logs(owner: string, jobId: string) {
    await getJob({ ...this.options(), namespace: owner, jobId });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5_000);
    let text = "";
    try {
      for await (const chunk of streamJobLogs({
        ...this.options(),
        namespace: owner,
        jobId,
        fetch: (url, init) => this.transport(url, { ...init, signal: abort.signal }),
      })) {
        text += chunk.message;
        if (text.length >= 64 * 1024) break;
      }
    } catch (failure) {
      if (!abort.signal.aborted) throw failure;
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
    return {
      text: text
        .split(this.accessToken)
        .join("[REDACTED]")
        .slice(0, 64 * 1024),
      bounded_snapshot: true,
    };
  }

  async privateBucket(owner: string, bucket: string) {
    const response = await this.transport(
      `https://huggingface.co/api/buckets/${encodeURIComponent(owner)}/${encodeURIComponent(bucket)}`,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok || (await response.json()).private !== true)
      throw new Error("An existing private personal Bucket is required");
  }

  async buckets(owner: string) {
    const response = await this.transport(
      `https://huggingface.co/api/buckets/${encodeURIComponent(owner)}`,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error("Bucket listing permission is unavailable");
    const values: unknown = await response.json();
    if (!Array.isArray(values)) throw new Error("Invalid Bucket listing");
    // Do not follow provider pagination links with credentials. Manual selection
    // and validation remain available for Buckets outside this first page.
    const items = values.flatMap((value) => {
      if (
        !value ||
        typeof value !== "object" ||
        value.private !== true ||
        typeof value.id !== "string" ||
        !value.id.startsWith(`${owner}/`)
      )
        return [];
      const name = value.id.slice(owner.length + 1);
      return /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(name) ? [{ name }] : [];
    });
    return { items, first_page_only: true };
  }

  async createBucket(owner: string, bucket: string) {
    const response = await this.transport(
      `https://huggingface.co/api/buckets/${encodeURIComponent(owner)}/${encodeURIComponent(bucket)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ private: true }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok)
      throw new Error(
        "Private Bucket creation failed; inspect existing Buckets before retrying",
      );
  }

  async results(owner: string, bucket: string, runId: string) {
    await this.privateBucket(owner, bucket);
    const files = [];
    for await (const file of listFiles({
      ...this.options(),
      repo: { type: "bucket", name: `${owner}/${bucket}` },
      path: `runs/${runId}`,
      recursive: true,
    })) {
      if (file.type !== "file") continue;
      files.push({ path: file.path, size: file.size });
      if (files.length >= 1000) break;
    }
    return {
      files,
      bounded_listing: true,
      url: `https://huggingface.co/buckets/${encodeURIComponent(owner)}/${encodeURIComponent(bucket)}`,
    };
  }

  async artifact(owner: string, bucket: string, path: string) {
    await this.privateBucket(owner, bucket);
    const response = await this.transport(
      `https://huggingface.co/buckets/${encodeURIComponent(owner)}/${encodeURIComponent(bucket)}/resolve/${path.split("/").map(encodeURIComponent).join("/")}`,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok || !response.body) throw new Error("Artifact unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256 * 1024) throw new Error("Artifact exceeds preview limit");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel();
    }
    return { text: text.split(this.accessToken).join("[REDACTED]") };
  }

  async launch(input: {
    owner: string;
    bucket: string;
    runId: string;
    image: string;
    hardware: SpaceHardwareFlavor;
    runtimeSeconds: number;
    jobTimeoutSeconds: number;
    config: unknown;
  }) {
    await this.privateBucket(input.owner, input.bucket);
    const job = await runJob({
      ...this.options(),
      namespace: input.owner,
      dockerImage: input.image,
      command: ["python", "/opt/runner/runner.py"],
      flavor: input.hardware,
      timeoutSeconds: input.jobTimeoutSeconds,
      attempts: 1,
      labels: {
        "harbor-hf-role": "runner",
        "harbor-hf-run": input.runId,
        "harbor-hf-mode": (input.config as { install_only?: boolean }).install_only
          ? "setup"
          : "benchmark",
      },
      environment: {
        HARBOR_HF_OWNER: input.owner,
        HARBOR_HF_RESULTS_BUCKET: input.bucket,
        HARBOR_HF_RUN_ID: input.runId,
        HARBOR_HF_RUNTIME_SECONDS: String(input.runtimeSeconds),
        HARBOR_HF_CONFIG_B64: Buffer.from(JSON.stringify(input.config)).toString(
          "base64",
        ),
      },
      secrets: { HARBOR_HF_USER_TOKEN: this.accessToken },
    });
    return {
      id: job.id,
      run_id: input.runId,
      url: `https://huggingface.co/jobs/${encodeURIComponent(input.owner)}/${encodeURIComponent(job.id)}`,
      sandbox_cleanup: "unverified",
    };
  }
}
