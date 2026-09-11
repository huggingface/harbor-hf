import { fastAgentWorkbenchStarter } from "@harbor-hf/control-core";
import { describe, expect, it } from "vitest";
import { fastAgentStarter, fxStarter } from "../src/workbench";

describe("Workbench starter recipes", () => {
  it("keeps the pinned Fast Agent installer and direct route bindings", () => {
    expect(fastAgentStarter.setup_command).toContain("uv_version=0.12.5");
    expect(fastAgentStarter.setup_command).toContain(
      "68a509da24b06b4223a1c0175fb5eb5bc79342b76cbeff0cfe51ac3f5b17b6b2",
    );
    expect(fastAgentStarter.setup_command).toContain("fast-agent-mcp==0.10.24");
    expect(fastAgentStarter.setup_command).toBe(
      fastAgentWorkbenchStarter.setup_command,
    );
    expect(fastAgentStarter.run_command).toBe(fastAgentWorkbenchStarter.run_command);
    expect(fastAgentStarter.environment).toEqual(fastAgentWorkbenchStarter.environment);
    expect(fastAgentStarter.outputs).toEqual(fastAgentWorkbenchStarter.outputs);
    expect(fastAgentStarter.run_command).toContain('HF_TOKEN="$OPENAI_API_KEY"');
    expect(fastAgentStarter.run_command).toContain('SSL_CERT_FILE="$ca_bundle"');
    expect(fastAgentStarter.run_command).toContain(
      "import certifi; print(certifi.where())",
    );
    expect(fastAgentStarter.run_command).not.toContain("--base-url");
    expect(fastAgentStarter.run_command).toContain('--model "$harness_model"');
    expect(fastAgentStarter.environment.map((item) => item.source)).toEqual(
      expect.arrayContaining(["model_base_url", "model_api_key"]),
    );
  });

  it("keeps the pinned FX release checksums without claiming a direct model route", () => {
    expect(fxStarter.setup_command).toContain("fx_version=0.0.6");
    expect(fxStarter.setup_command).toContain(
      "120fa992df8caf982e17ca9e9e3966c790b0d150480511eaf51392e66a0f0b84",
    );
    expect(fxStarter.setup_command).toContain(
      "0dfd53224c5ecede601bb8ce649f84fab6db05a39afbcd5b39e6091833f6c4d7",
    );
    expect(fxStarter.environment.map((item) => item.source)).not.toContain(
      "model_base_url",
    );
  });
});
