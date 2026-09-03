import type { AgentWorkbenchRecipeV1 } from "@harbor-hf/contracts";
import type { paths } from "./generated/api";

export type SessionResponse =
  paths["/api/v1/auth/session"]["get"]["responses"][200]["content"]["application/json"];
export type SystemResponse =
  paths["/api/v1/system"]["get"]["responses"][200]["content"]["application/json"];
export type NamespaceCapacity =
  paths["/api/v1/capacity"]["get"]["responses"][200]["content"]["application/json"];
export type RunList =
  paths["/api/v1/runs"]["get"]["responses"][200]["content"]["application/json"];
export type Run =
  paths["/api/v1/runs/{run_id}"]["get"]["responses"][200]["content"]["application/json"];
export type Capacity =
  paths["/api/v1/runs/{run_id}/capacity"]["get"]["responses"][200]["content"]["application/json"];
export type TaskList =
  paths["/api/v1/runs/{run_id}/tasks"]["get"]["responses"][200]["content"]["application/json"];
export type TaskDetail =
  paths["/api/v1/runs/{run_id}/tasks/{task_id}"]["get"]["responses"][200]["content"]["application/json"];
export type JobList =
  paths["/api/v1/jobs"]["get"]["responses"][200]["content"]["application/json"];
export type EndpointList =
  paths["/api/v1/endpoints"]["get"]["responses"][200]["content"]["application/json"];
export type ProfileList =
  paths["/api/v1/profiles"]["get"]["responses"][200]["content"]["application/json"];
export type ResultList =
  paths["/api/v1/results"]["get"]["responses"][200]["content"]["application/json"];
export type Leaderboard =
  paths["/api/v1/leaderboard"]["get"]["responses"][200]["content"]["application/json"];
export type ResultDetail =
  paths["/api/v1/results/{publication_id}"]["get"]["responses"][200]["content"]["application/json"];
export type AuditResponse =
  paths["/api/v1/audit"]["get"]["responses"][200]["content"]["application/json"];
export type RunSubmission =
  paths["/api/v1/runs"]["post"]["requestBody"]["content"]["application/json"];
export type RunAction =
  paths["/api/v1/runs/{run_id}/actions"]["post"]["requestBody"]["content"]["application/json"];
export type Accepted =
  paths["/api/v1/runs"]["post"]["responses"][202]["content"]["application/json"];

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
    readonly requestId: string | null = null,
    readonly retryAt: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

function retryAt(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Date.now() + seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? date : null;
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
    throw new ApiError(
      0,
      "network_error",
      "The control service is unreachable. Check your connection and try again.",
    );
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string; request_id?: string };
    } | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? "request_failed",
      body?.error?.message ?? `Request failed with ${response.status}`,
      body?.error?.request_id ?? null,
      retryAt(response.headers.get("Retry-After")),
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function submitRun(
  input: RunSubmission,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<Accepted> {
  return request<Accepted>("/api/v1/runs", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

export async function signOut(): Promise<void> {
  return request<void>("/auth/logout", { method: "POST" });
}

export async function actOnRun(runId: string, input: RunAction): Promise<Accepted> {
  return request<Accepted>(`/api/v1/runs/${encodeURIComponent(runId)}/actions`, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
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
