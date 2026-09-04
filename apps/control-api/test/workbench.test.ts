import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fastAgentWorkbenchStarter } from "@harbor-hf/control-core";
import type {
  WorkbenchJobClient,
  WorkbenchJobEvent,
  WorkbenchJobRecovery,
  WorkbenchJobRequest,
  WorkbenchJobSnapshot,
} from "@harbor-hf/hf-adapters";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchRuntime } from "../src/workbench.js";

describe.sequential("local Workbench runner", () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("does not report completion before file inventory is ready", async () => {
    const bin = await mkdtemp(join(tmpdir(), "harbor-hf-fake-docker-"));
    const docker = join(bin, "docker");
    await writeFile(
      docker,
      `#!/bin/sh
workspace=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--volume" ]; then
    shift
    case "$1" in
      *:/workspace:rw) workspace="\${1%:/workspace:rw}" ;;
    esac
  fi
  shift
done
mkdir -p "$workspace/generated"
i=0
while [ "$i" -lt 1000 ]; do
  printf 'file %s\\n' "$i" > "$workspace/generated/file-$i.txt"
  i=$((i + 1))
done
printf 'fake setup complete\\n'
`,
      { mode: 0o700 },
    );
    await chmod(docker, 0o700);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;

    const runtime = new WorkbenchRuntime("docker", "unused:test-image");
    try {
      const started = await runtime.startSetup(
        fastAgentWorkbenchStarter,
        "test-operator",
        "inventory-ready",
      );
      let current = started;
      while (["queued", "running"].includes(current.status)) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        current = (await runtime.getSetup(
          started.setup_test_id,
          "test-operator",
        )) as typeof current;
      }

      expect(current.status).toBe("passed");
      expect(current.files).toHaveLength(1000);
      expect(current.files[0]?.path).toMatch(/^generated\/file-\d+\.txt$/);
      await expect(
        runtime.attestPassedSetup(
          started.setup_test_id,
          "test-operator",
          fastAgentWorkbenchStarter,
        ),
      ).resolves.toMatchObject({
        setup_test_id: started.setup_test_id,
        recipe_digest: started.recipe_digest,
        revision_id: started.revision_id,
      });
      await expect(
        runtime.attestPassedSetup(
          started.setup_test_id,
          "different-operator",
          fastAgentWorkbenchStarter,
        ),
      ).rejects.toThrow("setup test is unavailable for this actor");
      await expect(
        runtime.attestPassedSetup(started.setup_test_id, "test-operator", {
          ...fastAgentWorkbenchStarter,
          run_command: `${fastAgentWorkbenchStarter.run_command}\nprintf changed`,
        }),
      ).rejects.toThrow("setup test does not match this exact recipe");
    } finally {
      await runtime.close();
    }
  });

  it("cancels a running setup and preserves its streamed logs", async () => {
    const bin = await mkdtemp(join(tmpdir(), "harbor-hf-fake-docker-"));
    const docker = join(bin, "docker");
    await writeFile(
      docker,
      `#!/bin/sh
if [ "$1" = "kill" ]; then
  pid_file="/tmp/fake-docker-$2.pid"
  if [ -f "$pid_file" ]; then
    kill -TERM "$(cat "$pid_file")"
  fi
  exit 0
fi
name=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--name" ]; then
    shift
    name="$1"
  fi
  shift
done
pid_file="/tmp/fake-docker-$name.pid"
printf '%s' "$$" > "$pid_file"
trap 'rm -f "$pid_file"; exit 143' TERM INT
printf 'install started\\n'
while :; do sleep 1; done
`,
      { mode: 0o700 },
    );
    await chmod(docker, 0o700);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;

    const runtime = new WorkbenchRuntime("docker", "unused:test-image");
    try {
      const started = await runtime.startSetup(
        fastAgentWorkbenchStarter,
        "test-operator",
        "cancel-running",
      );
      await expect
        .poll(async () => {
          const logs = await runtime.logs(started.setup_test_id, "test-operator");
          return logs?.stdout;
        })
        .toContain("install started");

      const cancelling = await runtime.cancelSetup(
        started.setup_test_id,
        "test-operator",
      );
      expect(cancelling?.status).toBe("cancelling");

      await expect
        .poll(async () => {
          const setup = await runtime.getSetup(started.setup_test_id, "test-operator");
          return setup?.status;
        })
        .toBe("cancelled");
      expect(
        (await runtime.logs(started.setup_test_id, "test-operator"))?.stdout,
      ).toContain("install started");
      expect(
        (await runtime.cancelSetup(started.setup_test_id, "test-operator"))?.status,
      ).toBe("cancelled");
    } finally {
      await runtime.close();
    }
  });
});

class FakeWorkbenchJobs implements WorkbenchJobClient {
  readonly requests: WorkbenchJobRequest[] = [];
  readonly cancellations: string[] = [];
  private eventCalls = 0;
  private resultEmitted = false;
  private staleSnapshotObserved = false;

  constructor(
    private cancelled = false,
    private staleSnapshotAfterResult = false,
  ) {}

  async list(ownerDigest: string): Promise<WorkbenchJobRecovery[]> {
    const request = this.requests[0];
    if (!request || request.owner_digest !== ownerDigest) return [];
    return [
      {
        setup_id: request.setup_id,
        recipe_digest: request.recipe_digest,
        revision_id: request.revision_id,
        snapshot: this.snapshot(this.cancelled ? "CANCELED" : "COMPLETED"),
      },
    ];
  }

  async start(request: WorkbenchJobRequest): Promise<WorkbenchJobSnapshot> {
    this.requests.push(request);
    return this.snapshot("RUNNING");
  }

  async observe(): Promise<WorkbenchJobSnapshot> {
    if (
      this.staleSnapshotAfterResult &&
      this.resultEmitted &&
      !this.staleSnapshotObserved
    ) {
      this.staleSnapshotObserved = true;
      return this.snapshot("RUNNING");
    }
    return this.snapshot(this.cancelled ? "CANCELED" : "COMPLETED");
  }

  async *events(_jobId: string, signal: AbortSignal): AsyncIterable<WorkbenchJobEvent> {
    this.eventCalls += 1;
    yield { kind: "stdout", sequence: 0, content: "remote setup started\n" };
    if (this.cancelled || signal.aborted) return;
    if (this.eventCalls === 1) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
      return;
    }
    yield {
      kind: "file",
      sequence: 1,
      root: "workspace",
      path: "created.txt",
      size: 7,
      text: true,
      content: "<safe>\n",
    };
    this.resultEmitted = true;
    yield { kind: "result", sequence: 2, exit_code: 0, timed_out: false };
  }

  async cancel(jobId: string): Promise<WorkbenchJobSnapshot> {
    this.cancellations.push(jobId);
    this.cancelled = true;
    return this.snapshot("CANCELED");
  }

  private snapshot(stage: string): WorkbenchJobSnapshot {
    return {
      job_id: "job-workbench-1",
      stage,
      message: null,
      created_at: "2026-08-16T00:00:00Z",
      started_at: "2026-08-16T00:00:01Z",
      completed_at: stage === "RUNNING" ? null : "2026-08-16T00:00:02Z",
    };
  }
}

describe("Hugging Face Workbench runner", () => {
  it("streams remote logs and bounded file previews without exposing another owner", async () => {
    const jobs = new FakeWorkbenchJobs();
    const runtime = new WorkbenchRuntime(
      "hf-jobs",
      "example.invalid/setup@sha256:test",
      jobs,
      10,
      10,
    );
    try {
      const started = await runtime.startSetup(
        fastAgentWorkbenchStarter,
        "test-operator",
        "remote-passed",
      );
      await expect
        .poll(async () => {
          const setup = await runtime.getSetup(started.setup_test_id, "test-operator");
          return setup?.status;
        })
        .toBe("passed");
      const setup = await runtime.getSetup(started.setup_test_id, "test-operator");
      expect(setup?.files).toHaveLength(1);
      expect(jobs.requests).toHaveLength(1);
      expect(jobs.requests[0]?.environment).not.toHaveProperty("HF_TOKEN");
      expect(
        await runtime.getSetup(started.setup_test_id, "different-operator"),
      ).toBeNull();
      expect(
        await runtime.logs(started.setup_test_id, "different-operator"),
      ).toBeNull();

      const file = setup?.files[0];
      expect(file).toBeDefined();
      expect(
        await runtime.file(started.setup_test_id, file?.file_id ?? "", "test-operator"),
      ).toEqual({ content: "<safe>\n", truncated: false });
      expect(
        await runtime.file(
          started.setup_test_id,
          file?.file_id ?? "",
          "different-operator",
        ),
      ).toBeNull();
      expect((await runtime.logs(started.setup_test_id, "test-operator"))?.stdout).toBe(
        "remote setup started\n",
      );
    } finally {
      await runtime.close();
    }
  });

  it("keeps a successful result terminal when the provider snapshot lags", async () => {
    const jobs = new FakeWorkbenchJobs(false, true);
    const runtime = new WorkbenchRuntime(
      "hf-jobs",
      "example.invalid/setup@sha256:test",
      jobs,
      10,
      10,
    );
    try {
      const started = await runtime.startSetup(
        fastAgentWorkbenchStarter,
        "test-operator",
        "remote-stale-snapshot",
      );
      await expect
        .poll(async () => {
          const setup = await runtime.getSetup(started.setup_test_id, "test-operator");
          return setup?.exit_code;
        })
        .toBe(0);
      await expect(
        runtime.getSetup(started.setup_test_id, "test-operator"),
      ).resolves.toMatchObject({
        status: "passed",
        exit_code: 0,
      });
    } finally {
      await runtime.close();
    }
  });

  it("cancels the exact remote Job and keeps the setup actor-scoped", async () => {
    const jobs = new FakeWorkbenchJobs(true);
    const runtime = new WorkbenchRuntime(
      "hf-jobs",
      "example.invalid/setup@sha256:test",
      jobs,
      10,
      10,
    );
    try {
      const started = await runtime.startSetup(
        fastAgentWorkbenchStarter,
        "test-operator",
        "remote-cancelled",
      );
      expect(
        await runtime.cancelSetup(started.setup_test_id, "different-operator"),
      ).toBeNull();
      const cancelling = await runtime.cancelSetup(
        started.setup_test_id,
        "test-operator",
      );
      expect(["cancelling", "cancelled"]).toContain(cancelling?.status);
      await expect
        .poll(async () => {
          const setup = await runtime.getSetup(started.setup_test_id, "test-operator");
          return setup?.status;
        })
        .toBe("cancelled");
      expect(jobs.cancellations).toEqual(["job-workbench-1"]);
    } finally {
      await runtime.close();
    }
  });

  it("recovers an actor-owned labelled Job after runtime state is lost", async () => {
    const jobs = new FakeWorkbenchJobs();
    const first = new WorkbenchRuntime(
      "hf-jobs",
      "example.invalid/setup@sha256:test",
      jobs,
      10,
      10,
    );
    const started = await first.startSetup(
      fastAgentWorkbenchStarter,
      "test-operator",
      "recover-labelled",
    );
    await expect
      .poll(async () => {
        const setup = await first.getSetup(started.setup_test_id, "test-operator");
        return setup?.status;
      })
      .toBe("passed");
    await first.close();

    const recovered = new WorkbenchRuntime(
      "hf-jobs",
      "example.invalid/setup@sha256:test",
      jobs,
      10,
      10,
    );
    try {
      const setups = await recovered.listSetups("test-operator");
      expect(setups[0]).toMatchObject({
        setup_test_id: started.setup_test_id,
        recipe_digest: started.recipe_digest,
        revision_id: started.revision_id,
      });
      await expect(
        recovered.attestPassedSetup(
          started.setup_test_id,
          "test-operator",
          fastAgentWorkbenchStarter,
        ),
      ).rejects.toThrow("must be rerun after service restart");
      expect(await recovered.listSetups("different-operator")).toEqual([]);
    } finally {
      await recovered.close();
    }
  });
});
