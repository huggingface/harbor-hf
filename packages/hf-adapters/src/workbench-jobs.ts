import {
  cancelJob,
  getJob,
  listJobs,
  runJob,
  type SpaceHardwareFlavor,
  streamJobLogs,
} from "@huggingface/hub";

const PROTOCOL_PREFIX = "HARBOR_HF_WORKBENCH_V1 ";
const MAX_EVENT_LINE_BYTES = 128 * 1024;
const MAX_PATH_BYTES = 4 * 1024;
const MAX_FILE_PREVIEW_BYTES = 64 * 1024;
const FINALIZATION_GRACE_SECONDS = 60;
const AMBIGUOUS_ADOPTION_ATTEMPTS = 5;

const REMOTE_SETUP_WRAPPER = String.raw`
import base64
import json
import os
import selectors
import signal
import stat
import subprocess
import time

PREFIX = "HARBOR_HF_WORKBENCH_V1 "
MAX_LOG_BYTES = 2 * 1024 * 1024
MAX_FILES = 1000
MAX_PREVIEW_BYTES = 64 * 1024
MAX_TOTAL_PREVIEW_BYTES = 1024 * 1024

def decode(name):
    return base64.b64decode(os.environ[name]).decode("utf-8")

def emit(value):
    global sequence
    value = dict(value)
    value["sequence"] = sequence
    sequence += 1
    payload = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    print(PREFIX + base64.b64encode(payload).decode("ascii"), flush=True)

def emit_stream(kind, data, retained):
    remaining = MAX_LOG_BYTES - retained[kind]
    if remaining <= 0:
        return
    selected = data[:remaining]
    if selected:
        emit({"kind": kind, "data": base64.b64encode(selected).decode("ascii")})
        retained[kind] += len(selected)
    if len(data) > len(selected) and retained[kind] == MAX_LOG_BYTES:
        emit({
            "kind": kind,
            "data": base64.b64encode(b"\n[further output truncated]\n").decode("ascii"),
        })
        retained[kind] += 1

def inventory(root_name, root, remaining_files, remaining_preview):
    records = []
    if not os.path.isdir(root):
        return records, remaining_files, remaining_preview
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        directories[:] = sorted(
            item
            for item in directories
            if not os.path.islink(os.path.join(current, item))
        )
        for name in sorted(files):
            if remaining_files <= 0:
                return records, remaining_files, remaining_preview
            absolute = os.path.join(current, name)
            try:
                metadata = os.lstat(absolute)
            except OSError:
                continue
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                continue
            relative = os.path.relpath(absolute, root).replace(os.sep, "/")
            if relative in ("", ".") or relative == ".." or relative.startswith("../"):
                continue
            record = {
                "kind": "file",
                "root": root_name,
                "path": relative,
                "size": metadata.st_size,
                "text": False,
            }
            if metadata.st_size <= MAX_PREVIEW_BYTES and remaining_preview > 0:
                try:
                    with open(absolute, "rb") as handle:
                        content = handle.read(MAX_PREVIEW_BYTES + 1)
                except OSError:
                    content = b""
                if len(content) <= MAX_PREVIEW_BYTES and b"\x00" not in content:
                    selected = content[:remaining_preview]
                    if len(selected) == len(content):
                        record["text"] = True
                        record["content"] = base64.b64encode(content).decode("ascii")
                        remaining_preview -= len(content)
            records.append(record)
            remaining_files -= 1
    return records, remaining_files, remaining_preview

os.makedirs("/workspace", exist_ok=True)
os.makedirs("/logs", exist_ok=True)
os.makedirs("/agent-home", exist_ok=True)
for managed_path in ("/workspace", "/logs", "/agent-home"):
    os.chown(managed_path, 1000, 1000)
sequence = 0

command = decode("HARBOR_HF_WORKBENCH_COMMAND_B64")
child_environment = json.loads(decode("HARBOR_HF_WORKBENCH_ENVIRONMENT_B64"))
child_environment["HOME"] = "/agent-home"
child_environment["PATH"] = "/agent-home/venv/bin:/usr/local/bin:/usr/bin:/bin"
timeout_seconds = int(os.environ["HARBOR_HF_WORKBENCH_TIMEOUT_SECONDS"])

process = subprocess.Popen(
    ["/bin/sh", "-eu", "-c", command],
    cwd="/workspace",
    env=child_environment,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    start_new_session=True,
    user=1000,
    group=1000,
)
selector = selectors.DefaultSelector()
selector.register(process.stdout, selectors.EVENT_READ, "stdout")
selector.register(process.stderr, selectors.EVENT_READ, "stderr")
retained = {"stdout": 0, "stderr": 0}
started = time.monotonic()
timed_out = False

while selector.get_map():
    if process.poll() is None and time.monotonic() - started >= timeout_seconds:
        timed_out = True
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
    for key, _ in selector.select(timeout=0.1):
        data = os.read(key.fileobj.fileno(), 4096)
        if data:
            emit_stream(key.data, data, retained)
        else:
            selector.unregister(key.fileobj)
            key.fileobj.close()

exit_code = process.wait()
remaining_files = MAX_FILES
remaining_preview = MAX_TOTAL_PREVIEW_BYTES
for root_name, root in (("workspace", "/workspace"), ("logs", "/logs")):
    records, remaining_files, remaining_preview = inventory(
        root_name,
        root,
        remaining_files,
        remaining_preview,
    )
    for record in records:
        emit(record)
emit({"kind": "result", "exit_code": exit_code, "timed_out": timed_out})
`;

type ApiJob = Awaited<ReturnType<typeof getJob>>;

export interface WorkbenchJobRequest {
  setup_id: string;
  owner_digest: string;
  recipe_digest: string;
  revision_id: string;
  setup_command: string;
  timeout_seconds: number;
  environment: Readonly<Record<string, string>>;
}

export interface WorkbenchJobRecovery {
  setup_id: string;
  recipe_digest: string;
  revision_id: string;
  snapshot: WorkbenchJobSnapshot;
}

export interface WorkbenchJobSnapshot {
  job_id: string;
  stage: string;
  message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export type WorkbenchJobEvent =
  | { kind: "stdout" | "stderr"; sequence: number; content: string }
  | {
      kind: "file";
      sequence: number;
      root: "workspace" | "logs";
      path: string;
      size: number;
      text: boolean;
      content: string | null;
    }
  | { kind: "result"; sequence: number; exit_code: number; timed_out: boolean };

export interface WorkbenchJobClient {
  start(request: WorkbenchJobRequest): Promise<WorkbenchJobSnapshot>;
  list(ownerDigest: string): Promise<WorkbenchJobRecovery[]>;
  observe(jobId: string): Promise<WorkbenchJobSnapshot>;
  events(jobId: string, signal: AbortSignal): AsyncIterable<WorkbenchJobEvent>;
  cancel(jobId: string): Promise<WorkbenchJobSnapshot>;
}

interface HuggingFaceWorkbenchJobsConfig {
  namespace: string;
  accessToken: string;
  image: string;
  flavor?: SpaceHardwareFlavor;
  maxActiveJobs?: number;
  hubUrl?: string;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function environment(request: WorkbenchJobRequest): Record<string, string> {
  return {
    HARBOR_HF_WORKBENCH_COMMAND_B64: encode(request.setup_command),
    HARBOR_HF_WORKBENCH_ENVIRONMENT_B64: encode(JSON.stringify(request.environment)),
    HARBOR_HF_WORKBENCH_TIMEOUT_SECONDS: String(request.timeout_seconds),
    PYTHONUNBUFFERED: "1",
  };
}

function labels(request: WorkbenchJobRequest): Record<string, string> {
  return {
    harbor_hf_kind: "workbench-setup",
    harbor_hf_setup_id: request.setup_id,
    harbor_hf_owner_digest: request.owner_digest,
    harbor_hf_recipe_digest: request.recipe_digest.replace(/^sha256:/, ""),
    harbor_hf_revision_id: request.revision_id,
  };
}

function active(job: ApiJob): boolean {
  return ["RUNNING", "SCHEDULING", "UPDATING", "PAUSED"].includes(
    String(job.status.stage).toUpperCase(),
  );
}

function snapshot(job: ApiJob): WorkbenchJobSnapshot {
  const stage = String(job.status.stage);
  return {
    job_id: job.id,
    stage,
    message: typeof job.status.message === "string" ? job.status.message : null,
    created_at: job.createdAt,
    started_at: job.startedAt ?? null,
    completed_at: job.finishedAt ?? null,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function decodeEvent(line: string): WorkbenchJobEvent | null {
  if (!line.startsWith(PROTOCOL_PREFIX)) return null;
  if (Buffer.byteLength(line) > MAX_EVENT_LINE_BYTES) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(line.slice(PROTOCOL_PREFIX.length), "base64").toString("utf8"),
    );
  } catch {
    return null;
  }
  const value = record(decoded);
  if (
    !value ||
    typeof value.kind !== "string" ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0
  )
    return null;
  if (value.kind === "stdout" || value.kind === "stderr") {
    if (typeof value.data !== "string") return null;
    let content: Buffer;
    try {
      content = Buffer.from(value.data, "base64");
    } catch {
      return null;
    }
    if (content.length > MAX_FILE_PREVIEW_BYTES) return null;
    return {
      kind: value.kind,
      sequence: value.sequence,
      content: content.toString("utf8"),
    };
  }
  if (value.kind === "result") {
    if (
      typeof value.exit_code !== "number" ||
      !Number.isInteger(value.exit_code) ||
      typeof value.timed_out !== "boolean"
    )
      return null;
    return {
      kind: "result",
      sequence: value.sequence,
      exit_code: value.exit_code,
      timed_out: value.timed_out,
    };
  }
  if (value.kind !== "file") return null;
  if (
    (value.root !== "workspace" && value.root !== "logs") ||
    typeof value.path !== "string" ||
    Buffer.byteLength(value.path) > MAX_PATH_BYTES ||
    !value.path ||
    value.path.startsWith("/") ||
    value.path.includes("\\") ||
    hasControlCharacter(value.path) ||
    value.path === ".." ||
    value.path.startsWith("../") ||
    value.path.includes("/../") ||
    value.path.split("/").some((part) => part === "." || part === "..") ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    typeof value.text !== "boolean"
  )
    return null;
  let content: string | null = null;
  if (value.text) {
    if (typeof value.content !== "string") return null;
    const bytes = Buffer.from(value.content, "base64");
    if (bytes.length > MAX_FILE_PREVIEW_BYTES || bytes.includes(0)) return null;
    content = bytes.toString("utf8");
  }
  return {
    kind: "file",
    sequence: value.sequence,
    root: value.root,
    path: value.path,
    size: value.size,
    text: value.text,
    content,
  };
}

function expectedCommand(): string[] {
  return ["python", "-c", REMOTE_SETUP_WRAPPER];
}

function arraysEqual(left: readonly string[] | null | undefined, right: string[]) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function recordsEqual(
  left: Readonly<Record<string, string>> | null | undefined,
  right: Record<string, string>,
): boolean {
  if (!left) return false;
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function verifyJob(
  job: ApiJob,
  request: WorkbenchJobRequest,
  config: HuggingFaceWorkbenchJobsConfig,
): void {
  const expectedLabels = labels(request);
  const expectedEnvironment = environment(request);
  const stockJob = job as ApiJob & { retry?: unknown; timeout?: unknown };
  const timeout =
    typeof job.timeoutSeconds === "number"
      ? job.timeoutSeconds
      : typeof stockJob.timeout === "number"
        ? stockJob.timeout
        : null;
  const attempts =
    typeof job.attempts === "number"
      ? job.attempts
      : typeof stockJob.retry === "number"
        ? stockJob.retry + 1
        : null;
  if (
    job.dockerImage !== config.image ||
    !arraysEqual(job.command, expectedCommand()) ||
    job.flavor !== (config.flavor ?? "cpu-basic") ||
    job.arch !== "amd64" ||
    timeout !== request.timeout_seconds + FINALIZATION_GRACE_SECONDS ||
    attempts !== 1 ||
    !recordsEqual(job.labels, expectedLabels) ||
    !recordsEqual(job.environment, expectedEnvironment) ||
    (job.spaceId !== undefined && job.spaceId !== null) ||
    (job.arguments !== undefined &&
      job.arguments !== null &&
      job.arguments.length !== 0) ||
    (job.secrets?.length ?? 0) !== 0 ||
    (job.volumes?.length ?? 0) !== 0
  )
    throw new Error("existing Workbench Job does not match the requested setup");
}

export class HuggingFaceWorkbenchJobs implements WorkbenchJobClient {
  private launchTail = Promise.resolve();

  constructor(private readonly config: HuggingFaceWorkbenchJobsConfig) {}

  private parameters(): {
    namespace: string;
    accessToken: string;
    hubUrl?: string;
  } {
    return {
      namespace: this.config.namespace,
      accessToken: this.config.accessToken,
      ...(this.config.hubUrl ? { hubUrl: this.config.hubUrl } : {}),
    };
  }

  private async matching(request: WorkbenchJobRequest): Promise<ApiJob[]> {
    const jobs = await listJobs(this.parameters());
    return jobs.filter(
      (job) =>
        job.labels?.harbor_hf_kind === "workbench-setup" &&
        job.labels.harbor_hf_setup_id === request.setup_id,
    );
  }

  async list(ownerDigest: string): Promise<WorkbenchJobRecovery[]> {
    const jobs = await listJobs(this.parameters());
    return jobs
      .filter(
        (job) =>
          job.labels?.harbor_hf_kind === "workbench-setup" &&
          job.labels.harbor_hf_owner_digest === ownerDigest &&
          typeof job.labels.harbor_hf_setup_id === "string" &&
          typeof job.labels.harbor_hf_recipe_digest === "string" &&
          typeof job.labels.harbor_hf_revision_id === "string",
      )
      .sort((left, right) =>
        String(right.createdAt).localeCompare(String(left.createdAt)),
      )
      .slice(0, 20)
      .map((job) => ({
        setup_id: job.labels?.harbor_hf_setup_id as string,
        recipe_digest: `sha256:${job.labels?.harbor_hf_recipe_digest as string}`,
        revision_id: job.labels?.harbor_hf_revision_id as string,
        snapshot: snapshot(job),
      }));
  }

  async start(request: WorkbenchJobRequest): Promise<WorkbenchJobSnapshot> {
    const previous = this.launchTail;
    let release = () => {};
    this.launchTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.startSerialized(request);
    } finally {
      release();
    }
  }

  private async startSerialized(
    request: WorkbenchJobRequest,
  ): Promise<WorkbenchJobSnapshot> {
    const jobs = await listJobs(this.parameters());
    const existing = jobs.filter(
      (job) =>
        job.labels?.harbor_hf_kind === "workbench-setup" &&
        job.labels.harbor_hf_setup_id === request.setup_id,
    );
    if (existing.length > 1)
      throw new Error("multiple Hugging Face Jobs match this setup test");
    if (existing[0]) {
      verifyJob(existing[0], request, this.config);
      return snapshot(existing[0]);
    }
    if (jobs.filter(active).length >= (this.config.maxActiveJobs ?? 16))
      throw new Error("the namespace active Job limit has been reached");
    let job: ApiJob;
    let created = false;
    try {
      job = await runJob({
        ...this.parameters(),
        dockerImage: this.config.image,
        command: expectedCommand(),
        arguments: [],
        flavor: this.config.flavor ?? "cpu-basic",
        arch: "amd64",
        timeoutSeconds: request.timeout_seconds + FINALIZATION_GRACE_SECONDS,
        attempts: 1,
        labels: labels(request),
        environment: environment(request),
      });
      created = true;
    } catch (error) {
      let adopted: ApiJob[] = [];
      for (
        let attempt = 0;
        attempt < AMBIGUOUS_ADOPTION_ATTEMPTS && adopted.length === 0;
        attempt += 1
      ) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
        adopted = await this.matching(request);
      }
      if (adopted.length !== 1)
        throw new Error("Hugging Face Job launch outcome is ambiguous", {
          cause: error,
        });
      job = adopted[0] as ApiJob;
    }
    try {
      verifyJob(job, request, this.config);
    } catch (error) {
      if (created)
        await cancelJob({
          ...this.parameters(),
          jobId: job.id,
        }).catch(() => undefined);
      throw error;
    }
    return snapshot(job);
  }

  async observe(jobId: string): Promise<WorkbenchJobSnapshot> {
    return snapshot(
      await getJob({
        ...this.parameters(),
        jobId,
      }),
    );
  }

  async *events(jobId: string, signal: AbortSignal): AsyncIterable<WorkbenchJobEvent> {
    const customFetch: typeof fetch = (input, init) =>
      fetch(input, { ...init, signal });
    for await (const item of streamJobLogs({
      ...this.parameters(),
      jobId,
      fetch: customFetch,
    })) {
      if (typeof item.message !== "string") continue;
      for (const line of item.message.split(/\r?\n/)) {
        const event = decodeEvent(line);
        if (event) yield event;
      }
    }
  }

  async cancel(jobId: string): Promise<WorkbenchJobSnapshot> {
    return snapshot(
      await cancelJob({
        ...this.parameters(),
        jobId,
      }),
    );
  }
}
