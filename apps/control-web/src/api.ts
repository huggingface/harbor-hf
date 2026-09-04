import type { AgentWorkbenchRecipeV1, BenchmarkPresetV1 } from "@harbor-hf/contracts";

export interface Actor {
  username: string;
  role: "operator" | "reader";
  transport: "session" | "bearer" | "development";
}

export type SessionResponse =
  | { authenticated: false; login_url: string }
  | { authenticated: true; actor: Actor };

export type BenchmarkPreset = BenchmarkPresetV1;

export interface AgentPreset {
  schema_version: "v1";
  agent: string;
  version: string;
  reasoning_option: string | null;
  reasoning_values: string[];
}

export interface PresetsResponse {
  benchmarks: BenchmarkPreset[];
  agents: AgentPreset[];
}

export interface RunSubmission {
  benchmark: { name: string; preset: string };
  model: { id: string; provider: string; reasoning_effort: string };
  harness: { agent: string; version: string };
  cost_ceiling_usd_per_trial: number;
}

export interface RunRecord {
  schema_version: "v1";
  run_id: string;
  created_at: string;
  submitted_by: string;
  role: "final" | "diagnostic";
  harbor_revision: string;
  submission: RunSubmission;
  harbor_job_config: Record<string, unknown>;
}

export interface RunState {
  schema_version: "v1";
  run_id: string;
  revision: number;
  updated_at: string;
  desired_state: "run" | "paused" | "cancelled";
  actor: string;
  parent_jobs: Array<{ id: string; started_at: string }>;
}

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "cancelled"
  | "finished"
  | "cost_stopped";

export interface RunView {
  record: RunRecord;
  state: RunState;
  status: RunStatus;
  result: Record<string, unknown> | null;
}

export interface TrialSummary {
  run_id: string;
  trial_name: string;
  reward: number | null;
  cost_usd: number | null;
  status: "completed" | "error" | "cancelled";
}

export interface TrialDetail extends TrialSummary {
  result: Record<string, unknown>;
}

export interface ParentJob {
  id: string;
  run_id: string;
  role: "parent";
  stage: "queued" | "running" | "stopped" | "error";
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface LeaderboardRow {
  benchmark: string;
  preset: string;
  agent: string;
  agent_version: string;
  model: string;
  provider: string;
  reasoning_effort: string;
  n_attempts: number;
  n_trials: number;
  pass_rate: number;
  cost_usd: number | null;
}

export interface SystemResponse {
  source_revision: string;
  harbor_revision: string;
  write_mode: "disabled" | "enabled";
  ready: boolean;
  projection: { runs: number; trials: number; parent_jobs: number };
  capacity: { max_active_parent_jobs: number };
  workbench: {
    runner: "disabled" | "docker" | "hf-jobs";
    setup_enabled: boolean;
  };
  resources: { spaces: 1; buckets: 1; operator_secrets: 2 };
}

export interface PresetSubmission extends RunSubmission {
  role: "final" | "diagnostic";
}

export type WorkbenchRecipe = AgentWorkbenchRecipeV1;

export interface WorkbenchPreview {
  recipe: WorkbenchRecipe;
  recipe_digest: string;
  revision_id: string;
  setup_command: string;
  run_command: string;
  environment: Array<{
    name: string;
    source: WorkbenchRecipe["environment"][number]["source"];
    value: string;
    redacted: boolean;
  }>;
  harbor_agent: {
    import_path: string;
    override_setup_timeout_sec: number;
    kwargs: { config: Record<string, unknown> };
  };
  warnings: string[];
}

export interface WorkbenchFile {
  file_id: string;
  path: string;
  root: "workspace" | "logs";
  size: number;
  text: boolean;
}

export interface WorkbenchSetup {
  setup_test_id: string;
  recipe_digest: string;
  revision_id: string;
  status:
    | "queued"
    | "running"
    | "cancelling"
    | "cancelled"
    | "passed"
    | "failed"
    | "timed-out";
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  exit_code: number | null;
  error: string | null;
  files: WorkbenchFile[];
}

export interface WorkbenchSubmission {
  benchmark: { name: string; preset: string };
  model: { id: string; provider: string; reasoning_effort: "off" };
  cost_ceiling_usd_per_trial: number;
  role: "final" | "diagnostic";
  workbench: { recipe: WorkbenchRecipe; setup_test_id: string };
}

interface ErrorBody {
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
    retry_at?: string;
  };
}

export class ApiError extends Error {
  readonly requestId: string | undefined;
  readonly retryAt: string | undefined;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    details: { requestId?: string; retryAt?: string } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.requestId = details.requestId;
    this.retryAt = details.retryAt;
  }
}

function cookie(name: string): string | null {
  const prefix = `${encodeURIComponent(name)}=`;
  for (const item of document.cookie.split(";")) {
    const value = item.trim();
    if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length));
  }
  return null;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  const csrf = cookie("hhf_csrf");
  if (csrf && init.method && !["GET", "HEAD"].includes(init.method))
    headers.set("X-CSRF-Token", csrf);
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "network_error", "The control service is not reachable.");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorBody | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? "request_failed",
      body?.error?.message ?? `Request failed with status ${response.status}.`,
      {
        ...(body?.error?.request_id ? { requestId: body.error.request_id } : {}),
        ...(body?.error?.retry_at ? { retryAt: body.error.retry_at } : {}),
      },
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const getSession = (): Promise<SessionResponse> => api("/api/v1/session");
export const getSystem = (): Promise<SystemResponse> => api("/api/v1/system");
export const getPresets = (): Promise<PresetsResponse> => api("/api/v1/presets");
export const getRuns = async (): Promise<RunView[]> =>
  (await api<{ runs: RunView[] }>("/api/v1/runs")).runs;
export const getRun = (runId: string): Promise<RunView> =>
  api(`/api/v1/runs/${encodeURIComponent(runId)}`);
export const getTrials = async (runId: string): Promise<TrialSummary[]> =>
  (
    await api<{ trials: TrialSummary[] }>(
      `/api/v1/runs/${encodeURIComponent(runId)}/trials`,
    )
  ).trials;
export const getTrial = (runId: string, trialName: string): Promise<TrialDetail> =>
  api(
    `/api/v1/runs/${encodeURIComponent(runId)}/trials/${encodeURIComponent(trialName)}`,
  );
export const getJobs = async (): Promise<ParentJob[]> =>
  (await api<{ jobs: ParentJob[] }>("/api/v1/jobs")).jobs;
export const getLeaderboard = async (): Promise<LeaderboardRow[]> =>
  (await api<{ rows: LeaderboardRow[] }>("/api/v1/leaderboard")).rows;

export async function submitRun(
  input: PresetSubmission | WorkbenchSubmission,
  idempotencyKey = crypto.randomUUID(),
): Promise<{ created: boolean; run: RunRecord }> {
  return api("/api/v1/runs", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

export async function actOnRun(
  runId: string,
  action: "pause" | "resume" | "cancel",
): Promise<RunState> {
  return api(`/api/v1/runs/${encodeURIComponent(runId)}/${action}`, {
    method: "POST",
  });
}

export const previewWorkbenchRecipe = (recipe: WorkbenchRecipe) =>
  api<WorkbenchPreview>("/api/v1/workbench/preview", {
    method: "POST",
    body: JSON.stringify(recipe),
  });

export const startWorkbenchSetup = (recipe: WorkbenchRecipe) =>
  api<WorkbenchSetup>("/api/v1/workbench/setup-tests", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ recipe }),
  });

export const listWorkbenchSetups = async () =>
  (await api<{ setups: WorkbenchSetup[] }>("/api/v1/workbench/setup-tests")).setups;

export const getWorkbenchSetup = (setupId: string) =>
  api<WorkbenchSetup>(`/api/v1/workbench/setup-tests/${encodeURIComponent(setupId)}`);

export const cancelWorkbenchSetup = (setupId: string) =>
  api<WorkbenchSetup>(
    `/api/v1/workbench/setup-tests/${encodeURIComponent(setupId)}/cancel`,
    { method: "POST" },
  );

export const getWorkbenchLogs = (setupId: string) =>
  api<{ stdout: string; stderr: string }>(
    `/api/v1/workbench/setup-tests/${encodeURIComponent(setupId)}/logs`,
  );

export const getWorkbenchFile = (setupId: string, fileId: string) =>
  api<{ content: string; truncated: boolean }>(
    `/api/v1/workbench/setup-tests/${encodeURIComponent(setupId)}/files/${encodeURIComponent(fileId)}`,
  );

export async function signOut(): Promise<void> {
  await api("/auth/logout", { method: "POST" });
}
