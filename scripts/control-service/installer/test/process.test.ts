import { describe, expect, it } from "vitest";
import { BoundedJsonProcess, ProcessFailure } from "../process.js";

const adapter = new BoundedJsonProcess();

function request(
  source: string,
  overrides: Partial<{
    timeoutMs: number;
    maxStdoutBytes: number;
    maxStderrBytes: number;
  }> = {},
) {
  return {
    command: process.execPath,
    args: ["-e", source],
    timeoutMs: overrides.timeoutMs ?? 2_000,
    maxStdoutBytes: overrides.maxStdoutBytes ?? 1024,
    maxStderrBytes: overrides.maxStderrBytes ?? 1024,
  };
}

async function reason(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof ProcessFailure ? error.reason : undefined;
  }
}

describe("bounded JSON process adapter", () => {
  it("returns structured JSON", async () => {
    await expect(
      adapter.runJson(request("console.log(JSON.stringify({ok:true}))")),
    ).resolves.toEqual({ ok: true });
  });

  it("fails closed on malformed JSON and nonzero exits", async () => {
    expect(await reason(adapter.runJson(request('console.log("not-json")')))).toBe(
      "malformed_json",
    );
    expect(await reason(adapter.runJson(request("process.exitCode=7")))).toBe(
      "nonzero",
    );
  });

  it("classifies provider status without retaining stderr", async () => {
    try {
      await adapter.runJson(
        request(
          'process.stderr.write("403 Forbidden: private detail");process.exit(1)',
        ),
      );
      throw new Error("expected process failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessFailure);
      expect((error as ProcessFailure).providerCategory).toBe("forbidden");
      expect(error instanceof Error ? error.message : "").not.toContain(
        "private detail",
      );
    }
  });

  it("bounds stdout and stderr", async () => {
    expect(
      await reason(
        adapter.runJson(
          request('process.stdout.write("x".repeat(1000))', {
            maxStdoutBytes: 20,
          }),
        ),
      ),
    ).toBe("stdout_limit");
    expect(
      await reason(
        adapter.runJson(
          request('process.stderr.write("x".repeat(1000))', {
            maxStderrBytes: 20,
          }),
        ),
      ),
    ).toBe("stderr_limit");
  });

  it("kills timed out processes", async () => {
    expect(
      await reason(
        adapter.runJson(request("setInterval(()=>{},1000)", { timeoutMs: 20 })),
      ),
    ).toBe("timeout");
  });

  it("captures the CLI token exception as bounded secret text", async () => {
    await expect(
      adapter.runSecretText(request('console.log("token-placeholder")')),
    ).resolves.toBe("token-placeholder");
    expect(
      await reason(
        adapter.runSecretText(
          request('process.stdout.write("first-line\\nsecond-line")'),
        ),
      ),
    ).toBe("malformed_json");
  });
});
