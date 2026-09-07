import { describe, expect, it } from "vitest";
import { configureFailureCategory } from "../configure-diagnostics.js";
import { HfCli } from "../hf.js";
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

describe("closed CLI stderr diagnostics", () => {
  it.each([
    ["KeyError: 'stage'", "runtime_stage_missing"],
    ["json.decoder.JSONDecodeError: Expecting value", "json_decode"],
    ["simplejson.errors.JSONDecodeError: Expecting value", "json_decode"],
    ["JSONDecodeError: Extra data", "json_decode"],
    ["│ Invalid value.", "cli_validation"],
    ["httpx.ConnectError:", "transport"],
    ["httpx.ReadTimeout:", "transport"],
    ["httpx.RemoteProtocolError:", "transport"],
    ["Error: No such option:", "cli_argument"],
    ["Error: Missing argument 'TARGET'.", "cli_argument"],
    ["Error: Got unexpected extra argument", "cli_argument"],
    ["KeyError: 'stage_suffix'", undefined],
    ["KeyError: 'other'", undefined],
    ["custom.httpx.ConnectError:", undefined],
    ["httpx.UnknownError:", undefined],
    ["httpx.ConnectErrorSuffix:", undefined],
    ["UnknownError:", undefined],
  ])("classifies %s without retaining private output", async (signature, category) => {
    const suffix = "https://example.invalid/private?token=credential-placeholder";
    const error = await adapter
      .runJson(
        request(
          `process.stdout.write(${JSON.stringify(suffix)});process.stderr.write(${JSON.stringify(`${signature} ${suffix}`)});process.exitCode=1`,
        ),
      )
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ProcessFailure);
    expect(error).toMatchObject({ reason: "nonzero", providerCategory: category });
    expect(Object.getOwnPropertyNames(error).sort()).toEqual([
      "message",
      "name",
      "providerCategory",
      "reason",
      "stack",
    ]);
    const hf = new HfCli({
      async runJson() {
        throw error;
      },
      async runSecretText() {
        throw new Error("unused");
      },
    });
    const configuredError = await hf.version().catch((error: unknown) => error);
    expect(configureFailureCategory(configuredError)).toBe(
      category ? `provider_${category}` : "process_nonzero",
    );
    expect((configuredError as Error).cause).toBeUndefined();
    expect(JSON.stringify(configuredError)).not.toContain(suffix);
    expect(JSON.stringify(error)).not.toContain(suffix);
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).toBe("ProcessFailure: process failed: nonzero");
  });
});
