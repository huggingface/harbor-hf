import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HuggingFaceWorkbenchJobs,
  type WorkbenchJobEvent,
  type WorkbenchJobRequest,
} from "../src/workbench-jobs.js";

const testToken = ["hf", "not-a-real-workbench-control-credential"].join("_");
const protocolPrefix = "HARBOR_HF_WORKBENCH_V1 ";

const request: WorkbenchJobRequest = {
  setup_id: "setup-test-example",
  owner_digest: "c".repeat(64),
  recipe_digest: `sha256:${"a".repeat(64)}`,
  revision_id: "agent-recipe-example",
  setup_command: "printf 'hello\\n'",
  timeout_seconds: 120,
  environment: {
    WORKSPACE: "/workspace",
    LOGS: "/logs",
  },
};

interface JobBody {
  dockerImage: string;
  command: string[];
  arguments: string[];
  flavor: string;
  arch: string;
  timeoutSeconds: number;
  attempts: number;
  labels: Record<string, string>;
  environment: Record<string, string>;
  secrets?: Record<string, string>;
  volumes?: unknown[];
}

function apiJob(body: JobBody, overrides: Record<string, unknown> = {}) {
  return {
    type: "job",
    id: "job-workbench-1",
    createdAt: "2026-08-16T00:00:00Z",
    startedAt: "2026-08-16T00:00:01Z",
    finishedAt: null,
    dockerImage: body.dockerImage,
    command: body.command,
    arguments: body.arguments,
    environment: body.environment,
    flavor: body.flavor,
    arch: body.arch,
    timeout: body.timeoutSeconds,
    retry: body.attempts - 1,
    spaceId: null,
    secrets: [],
    labels: body.labels,
    volumes: [],
    status: { stage: "RUNNING", failureCount: 0 },
    ...overrides,
  };
}

function protocol(value: Record<string, unknown>): string {
  return `${protocolPrefix}${Buffer.from(JSON.stringify(value), "utf8").toString(
    "base64",
  )}`;
}

function sse(messages: string[]): Response {
  const body = messages
    .map(
      (message) =>
        `data: ${JSON.stringify({
          data: message,
          timestamp: "2026-08-16T00:00:00Z",
        })}\n`,
    )
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("HuggingFaceWorkbenchJobs", () => {
  it("launches one credentialless, volume-less disposable Job", async () => {
    let launchedBody: JobBody | null = null;
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (!init?.method)
          return new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        launchedBody = JSON.parse(String(init.body)) as JobBody;
        return new Response(JSON.stringify(apiJob(launchedBody)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceWorkbenchJobs({
      namespace: "example",
      accessToken: testToken,
      image: "python@sha256:test",
    });

    await expect(adapter.start(request)).resolves.toMatchObject({
      job_id: "job-workbench-1",
      stage: "RUNNING",
    });
    expect(launchedBody).not.toBeNull();
    const body = launchedBody as JobBody;
    expect(body.dockerImage).toBe("python@sha256:test");
    expect(body.command.slice(0, 2)).toEqual(["python", "-c"]);
    expect(body.command[2]).toContain("env=child_environment");
    expect(body.command[2]).toContain("user=1000");
    expect(body.command[2]).toContain("os.chown(managed_path, 1000, 1000)");
    expect(body.command[2]).not.toContain("os.environ.copy");
    expect(body.arguments).toEqual([]);
    expect(body.flavor).toBe("cpu-basic");
    expect(body.arch).toBe("amd64");
    expect(body.timeoutSeconds).toBe(180);
    expect(body.attempts).toBe(1);
    expect(body.labels).toEqual({
      harbor_hf_kind: "workbench-setup",
      harbor_hf_setup_id: request.setup_id,
      harbor_hf_owner_digest: request.owner_digest,
      harbor_hf_recipe_digest: "a".repeat(64),
      harbor_hf_revision_id: request.revision_id,
    });
    expect(body).not.toHaveProperty("secrets");
    expect(body).not.toHaveProperty("volumes");
    expect(body).not.toHaveProperty("spaceId");
    expect(body.environment).not.toHaveProperty("HF_TOKEN");
    expect(
      Buffer.from(
        body.environment.HARBOR_HF_WORKBENCH_COMMAND_B64 ?? "",
        "base64",
      ).toString("utf8"),
    ).toBe(request.setup_command);
    expect(
      JSON.parse(
        Buffer.from(
          body.environment.HARBOR_HF_WORKBENCH_ENVIRONMENT_B64 ?? "",
          "base64",
        ).toString("utf8"),
      ),
    ).toEqual(request.environment);
    expect(JSON.stringify(body)).not.toContain(testToken);
    const post = fetchMock.mock.calls.find((call) => {
      const init = call[1] as RequestInit | undefined;
      return init?.method === "POST";
    });
    expect(post).toBeDefined();
    const postInit = post?.[1] as RequestInit | undefined;
    expect(postInit?.headers).toMatchObject({
      Authorization: `Bearer ${testToken}`,
    });
  });

  it("adopts one matching immutable Job without launching another", async () => {
    let expected: JobBody | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (!init?.method)
          return new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        expected = JSON.parse(String(init.body)) as JobBody;
        return new Response(JSON.stringify(apiJob(expected)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const first = new HuggingFaceWorkbenchJobs({
      namespace: "example",
      accessToken: testToken,
      image: "python@sha256:test",
    });
    await first.start(request);
    expect(expected).not.toBeNull();

    const adoptionFetch = vi.fn(
      async () =>
        new Response(JSON.stringify([apiJob(expected as JobBody)]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", adoptionFetch);
    const second = new HuggingFaceWorkbenchJobs({
      namespace: "example",
      accessToken: testToken,
      image: "python@sha256:test",
    });
    await expect(second.start(request)).resolves.toMatchObject({
      job_id: "job-workbench-1",
    });
    expect(adoptionFetch).toHaveBeenCalledTimes(1);
  });

  it("refuses to exceed the configured namespace active Job limit", async () => {
    const activeBody: JobBody = {
      dockerImage: "unrelated@sha256:test",
      command: ["true"],
      arguments: [],
      flavor: "cpu-basic",
      arch: "amd64",
      timeoutSeconds: 60,
      attempts: 1,
      labels: { unrelated: "job" },
      environment: {},
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([apiJob(activeBody)]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceWorkbenchJobs({
      namespace: "example",
      accessToken: testToken,
      image: "python@sha256:test",
      maxActiveJobs: 1,
    });
    await expect(adapter.start(request)).rejects.toThrow("namespace active Job limit");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels a newly created Job whose returned specification is not attested", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!init?.method)
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (String(url).endsWith("/cancel"))
        return new Response(
          JSON.stringify({
            type: "job",
            id: "job-workbench-1",
            createdAt: "2026-08-16T00:00:00Z",
            flavor: "cpu-basic",
            status: { stage: "CANCELED", failureCount: 0 },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      const body = JSON.parse(String(init.body)) as JobBody;
      return new Response(
        JSON.stringify(
          apiJob(body, {
            dockerImage: "different@sha256:unexpected",
          }),
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceWorkbenchJobs({
      namespace: "example",
      accessToken: testToken,
      image: "python@sha256:test",
    });
    await expect(adapter.start(request)).rejects.toThrow(
      "does not match the requested setup",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/job-workbench-1/cancel");
  });

  it("parses only valid framed stdout, stderr, files, and result records", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          "ordinary provider diagnostic",
          protocol({
            kind: "stdout",
            sequence: 0,
            data: Buffer.from("<hello>\n").toString("base64"),
          }),
          protocol({
            kind: "stderr",
            sequence: 1,
            data: Buffer.from("warning\n").toString("base64"),
          }),
          protocol({
            kind: "file",
            sequence: 2,
            root: "workspace",
            path: "created.txt",
            size: 7,
            text: true,
            content: Buffer.from("<safe>\n").toString("base64"),
          }),
          protocol({
            kind: "file",
            sequence: 3,
            root: "workspace",
            path: "../escape",
            size: 1,
            text: false,
          }),
          `${protocolPrefix}not-base64`,
          protocol({ kind: "result", sequence: 4, exit_code: 0, timed_out: false }),
        ]),
      ),
    );
    const adapter = new HuggingFaceWorkbenchJobs({
      namespace: "example",
      accessToken: testToken,
      image: "python@sha256:test",
    });
    const events: WorkbenchJobEvent[] = [];
    for await (const event of adapter.events(
      "job-workbench-1",
      new AbortController().signal,
    ))
      events.push(event);
    expect(events).toEqual([
      { kind: "stdout", sequence: 0, content: "<hello>\n" },
      { kind: "stderr", sequence: 1, content: "warning\n" },
      {
        kind: "file",
        sequence: 2,
        root: "workspace",
        path: "created.txt",
        size: 7,
        text: true,
        content: "<safe>\n",
      },
      {
        kind: "result",
        sequence: 4,
        exit_code: 0,
        timed_out: false,
      },
    ]);
  });

  it("observes and cancels the exact remote Job", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            apiJob(
              {
                dockerImage: "python@sha256:test",
                command: [],
                arguments: [],
                flavor: "cpu-basic",
                arch: "amd64",
                timeoutSeconds: 180,
                attempts: 1,
                labels: {},
                environment: {},
              },
              {
                status: {
                  stage: init?.method === "POST" ? "CANCELED" : "RUNNING",
                  failureCount: 0,
                },
              },
            ),
          ),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new HuggingFaceWorkbenchJobs({
      namespace: "example",
      accessToken: testToken,
      image: "python@sha256:test",
    });
    await expect(adapter.observe("job-workbench-1")).resolves.toMatchObject({
      stage: "RUNNING",
    });
    await expect(adapter.cancel("job-workbench-1")).resolves.toMatchObject({
      stage: "CANCELED",
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/job-workbench-1/cancel");
  });
});
