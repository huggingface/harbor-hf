export interface Actor {
  username: string;
  role: "operator" | "reader";
  transport: "session" | "bearer" | "development";
}

export type Session =
  | { authenticated: false; login_url: string }
  | { authenticated: true; actor: Actor };

export interface BenchmarkPreset {
  schema_version: "v1";
  benchmark: string;
  preset: string;
  leaderboard_eligible: boolean;
}

export interface AgentPreset {
  schema_version: "v1";
  agent: string;
  version: string;
  reasoning_option: string | null;
  reasoning_values: string[];
}

export interface Presets {
  benchmarks: BenchmarkPreset[];
  agents: AgentPreset[];
}

export interface RunView {
  record: {
    run_id: string;
    created_at: string;
    role: "final" | "diagnostic";
    submission: {
      benchmark: { name: string; preset: string };
      model: { id: string; provider: string; reasoning_effort: string };
      harness: { agent: string; version: string };
      cost_ceiling_usd_per_trial: number;
    };
  };
  state: { desired_state: "run" | "paused" | "cancelled" };
  status: "queued" | "running" | "paused" | "cancelled" | "finished" | "cost_stopped";
}

export interface ParentJob {
  id: string;
  run_id: string;
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
}

export interface SystemState {
  source_revision: string;
  harbor_revision: string;
  write_mode: "disabled" | "enabled";
  ready: boolean;
  projection: { runs: number; trials: number; parent_jobs: number };
  capacity: { max_active_parent_jobs: number };
}

export interface PresetSubmission {
  benchmark: { name: string; preset: string };
  model: { id: string; provider: string; reasoning_effort: string };
  harness: { agent: string; version: string };
  cost_ceiling_usd_per_trial: number;
  role: "final" | "diagnostic";
}

export type WorkbenchRecipe = AgentWorkbenchRecipeV1;
export type WorkbenchPreview =
  paths["/api/v1/workbench/preview"]["post"]["responses"][200]["content"]["application/json"];
export type WorkbenchSetup =
  paths["/api/v1/workbench/setup-tests"]["post"]["responses"][202]["content"]["application/json"];
export type WorkbenchFile = WorkbenchSetup["files"][number];
export type WorkbenchLogs =
  paths["/api/v1/workbench/setup-tests/{setup_test_id}/logs"]["get"]["responses"][200]["content"]["application/json"];
export type WorkbenchFileContent =
  paths["/api/v1/workbench/setup-tests/{setup_test_id}/files/{file_id}"]["get"]["responses"][200]["content"]["application/json"];
export type BenchmarkConfigList =
  paths["/api/v1/workbench/benchmark-configs"]["get"]["responses"][200]["content"]["application/json"];
export type BenchmarkConfig = BenchmarkConfigList["items"][number];

export interface LocalHarborOptions {
  enabled: boolean;
  ready: boolean;
  reason: string | null;
  benchmark: string;
  model: string;
  task_names: string[];
  harbor_version: string | null;
  expected_harbor_version: string | null;
}

export interface LocalHarborRun {
  local_run_id: string;
  recipe_digest: string;
  status: "queued" | "running" | "cancelling" | "cancelled" | "succeeded" | "failed";
  benchmark: string;
  model: string;
  task_names: string[];
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  exit_code: number | null;
  error: string | null;
  config_path: string;
  result_path: string | null;
  command: string[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
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

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? "request_failed",
      body?.error?.message ?? `Request failed with status ${response.status}.`,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function submitRun(
  input: PresetSubmission,
): Promise<{ run: RunView["record"] }> {
  return request("/api/v1/runs", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

export async function setRunState(
  runId: string,
  action: "pause" | "resume" | "cancel",
): Promise<void> {
  await request(`/api/v1/runs/${encodeURIComponent(runId)}/${action}`, {
    method: "POST",
  });
}

export async function signOut(): Promise<void> {
  await request("/auth/logout", { method: "POST" });
}

export async function previewWorkbenchRecipe(
  recipe: WorkbenchRecipe,
): Promise<WorkbenchPreview> {
  return request<WorkbenchPreview>("/api/v1/workbench/preview", {
    method: "POST",
    body: JSON.stringify(recipe),
  });
}

export async function getBenchmarkConfigs(): Promise<BenchmarkConfigList> {
  return request<BenchmarkConfigList>("/api/v1/workbench/benchmark-configs");
}

export async function startWorkbenchSetup(
  recipe: WorkbenchRecipe,
): Promise<WorkbenchSetup> {
  return request<WorkbenchSetup>("/api/v1/workbench/setup-tests", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ recipe, confirmed: true }),
  });
}

export async function listWorkbenchSetups(): Promise<WorkbenchSetup[]> {
  return request<WorkbenchSetup[]>("/api/v1/workbench/setup-tests");
}

export async function getWorkbenchSetup(id: string): Promise<WorkbenchSetup> {
  return request<WorkbenchSetup>(
    `/api/v1/workbench/setup-tests/${encodeURIComponent(id)}`,
  );
}

export async function cancelWorkbenchSetup(id: string): Promise<WorkbenchSetup> {
  return request<WorkbenchSetup>(
    `/api/v1/workbench/setup-tests/${encodeURIComponent(id)}/cancel`,
    {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ confirmed: true }),
    },
  );
}

export async function getWorkbenchLogs(id: string): Promise<WorkbenchLogs> {
  return request<WorkbenchLogs>(
    `/api/v1/workbench/setup-tests/${encodeURIComponent(id)}/logs`,
  );
}

export async function getWorkbenchFile(
  setupId: string,
  fileId: string,
): Promise<WorkbenchFileContent> {
  return request<WorkbenchFileContent>(
    `/api/v1/workbench/setup-tests/${encodeURIComponent(setupId)}/files/${encodeURIComponent(fileId)}`,
  );
}

export async function getLocalHarborOptions(): Promise<LocalHarborOptions> {
  return request<LocalHarborOptions>("/api/v1/workbench/local-runs/options");
}

export async function previewLocalHarborConfig(
  recipe: WorkbenchRecipe,
  taskNames: string[],
): Promise<Record<string, unknown>> {
  const result = await request<{ config: Record<string, unknown> }>(
    "/api/v1/workbench/local-runs/preview",
    {
      method: "POST",
      body: JSON.stringify({ recipe, task_names: taskNames }),
    },
  );
  return result.config;
}

export async function startLocalHarborRun(
  recipe: WorkbenchRecipe,
  taskNames: string[],
): Promise<LocalHarborRun> {
  return request<LocalHarborRun>("/api/v1/workbench/local-runs", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      recipe,
      task_names: taskNames,
      confirmed: true,
    }),
  });
}

export async function listLocalHarborRuns(): Promise<LocalHarborRun[]> {
  return request<LocalHarborRun[]>("/api/v1/workbench/local-runs");
}

export async function getLocalHarborRun(id: string): Promise<LocalHarborRun> {
  return request<LocalHarborRun>(
    `/api/v1/workbench/local-runs/${encodeURIComponent(id)}`,
  );
}

export async function getLocalHarborLogs(
  id: string,
): Promise<{ stdout: string; stderr: string }> {
  return request<{ stdout: string; stderr: string }>(
    `/api/v1/workbench/local-runs/${encodeURIComponent(id)}/logs`,
  );
}

export async function cancelLocalHarborRun(id: string): Promise<LocalHarborRun> {
  return request<LocalHarborRun>(
    `/api/v1/workbench/local-runs/${encodeURIComponent(id)}/cancel`,
    {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ confirmed: true }),
    },
  );
}
