import { createInterface } from "node:readline/promises";
import { type Readable, Writable } from "node:stream";
import type { InstallerSecretInput } from "./workflow.js";

type TtyReadable = Readable & { isTTY?: boolean };
type TtyWritable = Writable & { isTTY?: boolean };

class MutedTerminalOutput extends Writable {
  muted = false;

  constructor(private readonly destination: Writable) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      if (!this.muted) this.destination.write(chunk, encoding);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error("terminal output failed"));
    }
  }
}

export class TtyInstallerSecretInput implements InstallerSecretInput {
  constructor(
    private readonly input: TtyReadable = process.stdin,
    private readonly output: TtyWritable = process.stderr,
  ) {}

  async read(name: "HF_TOKEN" | "HF_INFERENCE_TOKEN"): Promise<string | undefined> {
    if (!this.input.isTTY || !this.output.isTTY) return undefined;
    const mutedOutput = new MutedTerminalOutput(this.output);
    const readline = createInterface({
      input: this.input,
      output: mutedOutput,
      terminal: true,
      historySize: 0,
    });
    const label =
      name === "HF_TOKEN"
        ? "Control service credential"
        : "Inference-only credential/token";
    try {
      const pending = readline.question(`${label}: `);
      mutedOutput.muted = true;
      return await pending;
    } finally {
      mutedOutput.muted = false;
      this.output.write("\n");
      readline.close();
    }
  }
}
