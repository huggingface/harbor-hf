import type { paths } from "./generated/api";

export type SessionResponse =
  paths["/api/v1/auth/session"]["get"]["responses"][200]["content"]["application/json"];
export type SystemResponse =
  paths["/api/v1/system"]["get"]["responses"][200]["content"]["application/json"];
export type CampaignList =
  paths["/api/v1/campaigns"]["get"]["responses"][200]["content"]["application/json"];
export type Campaign =
  paths["/api/v1/campaigns/{campaign_id}"]["get"]["responses"][200]["content"]["application/json"];
export type TaskList =
  paths["/api/v1/campaigns/{campaign_id}/tasks"]["get"]["responses"][200]["content"]["application/json"];
export type TaskDetail =
  paths["/api/v1/campaigns/{campaign_id}/tasks/{task_id}"]["get"]["responses"][200]["content"]["application/json"];
export type JobList =
  paths["/api/v1/jobs"]["get"]["responses"][200]["content"]["application/json"];
export type EndpointList =
  paths["/api/v1/endpoints"]["get"]["responses"][200]["content"]["application/json"];
export type ProfileList =
  paths["/api/v1/profiles"]["get"]["responses"][200]["content"]["application/json"];
export type ResultList =
  paths["/api/v1/results"]["get"]["responses"][200]["content"]["application/json"];
export type ResultDetail =
  paths["/api/v1/results/{publication_id}"]["get"]["responses"][200]["content"]["application/json"];
export type AuditResponse =
  paths["/api/v1/audit"]["get"]["responses"][200]["content"]["application/json"];
export type CampaignSubmission =
  paths["/api/v1/campaigns"]["post"]["requestBody"]["content"]["application/json"];
export type CampaignAction =
  paths["/api/v1/campaigns/{campaign_id}/actions"]["post"]["requestBody"]["content"]["application/json"];
export type Accepted =
  paths["/api/v1/campaigns"]["post"]["responses"][202]["content"]["application/json"];

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

export async function submitCampaign(input: CampaignSubmission): Promise<Accepted> {
  return request<Accepted>("/api/v1/campaigns", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}

export async function signOut(): Promise<void> {
  return request<void>("/auth/logout", { method: "POST" });
}

export async function actOnCampaign(
  campaignId: string,
  input: CampaignAction,
): Promise<Accepted> {
  return request<Accepted>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/actions`,
    {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(input),
    },
  );
}
