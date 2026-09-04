import { describe, expect, it } from "vitest";
import { fastAgentStarter, fxStarter } from "../src/workbench";

describe("historical Workbench starter recipes", () => {
  it("keeps the pinned Fast Agent installer and direct route bindings", () => {
    expect(fastAgentStarter.setup_command).toContain("uv_version=0.12.5");
    expect(fastAgentStarter.setup_command).toContain(
      "68a509da24b06b4223a1c0175fb5eb5bc79342b76cbeff0cfe51ac3f5b17b6b2",
    );
    expect(fastAgentStarter.setup_command).toContain("fast-agent-mcp==0.10.16");
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
