import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { TtyInstallerSecretInput } from "../secret-input.js";

class TestTtyInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

class TestTtyOutput extends PassThrough {
  readonly isTTY = true;
  readonly chunks: Buffer[] = [];

  constructor() {
    super();
    this.on("data", (chunk: Buffer) => this.chunks.push(Buffer.from(chunk)));
  }

  displayed(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

describe("installer secret input", () => {
  it("never attempts to read credentials without an interactive terminal", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    Object.defineProperty(input, "isTTY", { value: false });
    Object.defineProperty(output, "isTTY", { value: false });
    await expect(
      new TtyInstallerSecretInput(input, output).read("HF_TOKEN"),
    ).resolves.toBeUndefined();
    expect(output.readableLength).toBe(0);
  });

  it("prompts without echoing or retaining the credential", async () => {
    const input = new TestTtyInput();
    const output = new TestTtyOutput();
    const pending = new TtyInstallerSecretInput(input, output).read("HF_TOKEN");
    input.end("secret-placeholder\n");
    await expect(pending).resolves.toBe("secret-placeholder");
    const displayed = output.displayed();
    expect(displayed).toContain("Control service credential:");
    expect(displayed).not.toContain("secret-placeholder");
    expect(input.isRaw).toBe(false);
  });

  it("identifies the inference credential as a token", async () => {
    const input = new TestTtyInput();
    const output = new TestTtyOutput();
    const pending = new TtyInstallerSecretInput(input, output).read(
      "HF_INFERENCE_TOKEN",
    );
    input.end("inference-placeholder\n");
    await expect(pending).resolves.toBe("inference-placeholder");
    const displayed = output.displayed();
    expect(displayed).toContain("Inference-only credential/token:");
    expect(displayed).not.toContain("inference-placeholder");
    expect(input.isRaw).toBe(false);
  });
});
