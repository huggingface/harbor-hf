import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBuiltInProfiles } from "@harbor-hf/control-core/profiles";
import {
  fastAgentWorkbenchStarter,
  fxWorkbenchStarter,
} from "@harbor-hf/control-core/workbench";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalHarborRuntime } from "../src/local-harbor.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local Harbor runtime", () => {
  it("writes a secret-free config and owns asynchronous runs by actor", async () => {
    const root = await mkdtemp(join(tmpdir(), "hhf-local-harbor-"));
    roots.push(root);
    const harbor = join(root, "harbor");
    const starts = join(root, "starts");
    await writeFile(
      harbor,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        '  printf "0.22.0\\n"',
        "  exit 0",
        "fi",
        `printf x >> ${JSON.stringify(starts)}`,
        [
          'printf "inference=%s control=%s\\n" "$HF_INFERENCE_TOKEN" "$',
          '{HF_TOKEN-unset}"',
        ].join(""),
        'printf "fake Harbor started\\n"',
        "sleep 0.05",
        'printf "fake Harbor finished\\n"',
      ].join("\n"),
    );
    await chmod(harbor, 0o700);
    vi.stubEnv("HF_TOKEN", "control-service-secret");
    const profiles = await loadBuiltInProfiles(resolve("profiles"));
    const runtime = new LocalHarborRuntime(
      true,
      "local-inference-secret",
      join(root, "profiles"),
      profiles,
      harbor,
    );
    expect(runtime.options()).toMatchObject({
      enabled: true,
      ready: true,
      harbor_version: "0.22.0",
      expected_harbor_version: "0.22.0",
      task_names: ["adaptive-rejection-sampler", "modernize-scientific-stack"],
    });
    expect(() =>
      runtime.config(fxWorkbenchStarter, ["adaptive-rejection-sampler"]),
    ).toThrow("requires a direct model base URL binding");

    const [started, duplicate] = await Promise.all([
      runtime.start(
        fastAgentWorkbenchStarter,
        ["adaptive-rejection-sampler"],
        "operator-one",
        "request-one",
      ),
      runtime.start(
        fastAgentWorkbenchStarter,
        ["adaptive-rejection-sampler"],
        "operator-one",
        "request-one",
      ),
    ]);
    expect(started.status).toBe("running");
    expect(duplicate.local_run_id).toBe(started.local_run_id);
    expect(runtime.get(started.local_run_id, "operator-two")).toBeNull();
    await expect(
      runtime.start(
        fastAgentWorkbenchStarter,
        ["modernize-scientific-stack"],
        "operator-one",
        "request-one",
      ),
    ).rejects.toThrow("idempotency key");

    await vi.waitFor(() => {
      expect(runtime.get(started.local_run_id, "operator-one")?.status).toBe(
        "succeeded",
      );
    });
    const logs = runtime.logs(started.local_run_id, "operator-one")?.stdout ?? "";
    expect(logs).toContain("fake Harbor finished");
    expect(logs).toContain("inference=[redacted] control=unset");
    expect(logs).not.toContain("local-inference-secret");
    expect(logs).not.toContain("control-service-secret");
    expect(await readFile(starts, "utf8")).toBe("x");
    const config = await readFile(started.config_path, "utf8");
    expect(config).toContain('"task_names": [\n        "adaptive-rejection-sampler"');
    expect(config).toContain(
      ['"OPENAI_API_KEY": "$', '{HF_INFERENCE_TOKEN}"'].join(""),
    );
    expect(config).not.toContain("local-inference-secret");
    await runtime.close();
  });

  it("does not probe or execute Harbor when the local runtime is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "hhf-local-harbor-disabled-"));
    roots.push(root);
    const marker = join(root, "unexpected-spawn");
    const harbor = join(root, "harbor");
    await writeFile(
      harbor,
      `#!/bin/sh\nprintf spawned > ${JSON.stringify(marker)}\nprintf "0.22.0\\n"\n`,
    );
    await chmod(harbor, 0o700);
    const profiles = await loadBuiltInProfiles(resolve("profiles"));
    const runtime = new LocalHarborRuntime(
      false,
      "unused",
      join(root, "profiles"),
      profiles,
      harbor,
    );
    expect(runtime.options()).toMatchObject({
      enabled: false,
      ready: false,
      harbor_version: null,
    });
    await expect(readFile(marker, "utf8")).rejects.toThrow();
    await runtime.close();
  });
});
