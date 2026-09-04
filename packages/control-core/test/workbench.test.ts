import { describe, expect, it } from "vitest";
import {
  compileAgentWorkbenchRecipe,
  fastAgentWorkbenchStarter,
  fxWorkbenchStarter,
} from "../src/workbench.js";

describe("Agent Workbench recipe compiler", () => {
  it("compiles the Fast-Agent starter into one generic Harbor agent", () => {
    const preview = compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter);
    expect(preview.recipe.name).toBe("fast-agent");
    expect(preview.setup_command).toContain("uv_version=0.12.5");
    expect(preview.setup_command).toContain(
      "68a509da24b06b4223a1c0175fb5eb5bc79342b76cbeff0cfe51ac3f5b17b6b2",
    );
    expect(preview.setup_command).toContain("python_version=3.12.14");
    expect(preview.setup_command).toContain("fast-agent-mcp==0.10.16");
    expect(preview.setup_command).not.toContain('python -m venv "$AGENT_HOME/venv"');
    expect(preview.run_command).toContain("--base-url");
    expect(preview.run_command).toContain("<injected-model-base-url>");
    expect(preview.environment.find((item) => item.name === "OPENAI_API_KEY")).toEqual(
      expect.objectContaining({
        value: "<injected-model-api-key>",
        redacted: true,
      }),
    );
    expect(
      preview.environment.find((item) => item.name === "GENERIC_API_KEY"),
    ).toBeUndefined();
    expect(preview.harbor_agent).toMatchObject({
      import_path: "harbor_hf_agents.command_agent.agent:CommandAgent",
      override_setup_timeout_sec: 1800,
      kwargs: {
        config: {
          route_api: "chat-completions",
          outputs: [{ path: "fast-agent-results.json" }],
          run: {
            bindings: {
              OPENAI_API_KEY: "model_api_key",
              MODEL_BASE_URL: "model_base_url",
            },
          },
        },
      },
    });
    expect(JSON.stringify(preview.harbor_agent)).not.toContain("route_base_url");
    expect(JSON.stringify(preview.harbor_agent)).not.toContain("route_api_key");
    expect(JSON.stringify(preview)).not.toContain("harness_profile");
    expect(JSON.stringify(preview)).not.toContain("promotion");
    expect(JSON.stringify(preview)).not.toContain("preparation");
  });

  it("compiles the checksum-pinned FX starter through the generic recipe path", () => {
    const preview = compileAgentWorkbenchRecipe(fxWorkbenchStarter);
    expect(preview.recipe.name).toBe("fx");
    expect(preview.setup_command).toContain(
      [
        "https://releases.fx.sh/v",
        "$",
        "{fx_version}",
        "/fx-linux-",
        "$",
        "{fx_target}",
        ".tar.gz",
      ].join(""),
    );
    expect(preview.setup_command).toContain(
      "120fa992df8caf982e17ca9e9e3966c790b0d150480511eaf51392e66a0f0b84",
    );
    expect(preview.setup_command).toContain(
      "0dfd53224c5ecede601bb8ce649f84fab6db05a39afbcd5b39e6091833f6c4d7",
    );
    expect(preview.run_command).toContain('fx" ask --yolo --json --');
    expect(preview.harbor_agent).toMatchObject({
      import_path: "harbor_hf_agents.command_agent.agent:CommandAgent",
      override_setup_timeout_sec: 600,
      kwargs: {
        config: {
          route_api: "chat-completions",
          outputs: [{ path: "fx-results.json" }],
        },
      },
    });
  });

  it("produces stable identities and changes them with behavior", () => {
    const first = compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter);
    const second = compileAgentWorkbenchRecipe(
      structuredClone(fastAgentWorkbenchStarter),
    );
    const changed = compileAgentWorkbenchRecipe({
      ...structuredClone(fastAgentWorkbenchStarter),
      setup_timeout_seconds: 1700,
    });
    expect(second.recipe_digest).toBe(first.recipe_digest);
    expect(second.revision_id).toBe(first.revision_id);
    expect(changed.recipe_digest).not.toBe(first.recipe_digest);
    expect(changed.revision_id).not.toBe(first.revision_id);
  });

  it("rejects duplicate, reserved, and credential-like literals", () => {
    expect(() =>
      compileAgentWorkbenchRecipe({
        ...structuredClone(fastAgentWorkbenchStarter),
        environment: [
          { name: "DUPLICATE", source: "literal", value: "a" },
          { name: "DUPLICATE", source: "literal", value: "b" },
        ],
      }),
    ).toThrow("duplicated");
    expect(() =>
      compileAgentWorkbenchRecipe({
        ...structuredClone(fastAgentWorkbenchStarter),
        environment: [{ name: "HF_TOKEN", source: "literal", value: "value" }],
      }),
    ).toThrow("reserved");
    expect(() =>
      compileAgentWorkbenchRecipe({
        ...structuredClone(fastAgentWorkbenchStarter),
        environment: [
          { name: "HF_INFERENCE_TOKEN", source: "literal", value: "value" },
        ],
      }),
    ).toThrow("reserved");
    expect(() =>
      compileAgentWorkbenchRecipe({
        ...structuredClone(fastAgentWorkbenchStarter),
        environment: [
          {
            name: "SERVICE_API_KEY",
            source: "literal",
            value: "not-a-secret",
          },
        ],
      }),
    ).toThrow("credential-like");
    expect(() =>
      compileAgentWorkbenchRecipe({
        ...structuredClone(fastAgentWorkbenchStarter),
        setup_command: `printf '%s' '${["hf", "not-a-real-token-value"].join("_")}'`,
      }),
    ).toThrow("credential-like");
    expect(() =>
      compileAgentWorkbenchRecipe({
        ...structuredClone(fastAgentWorkbenchStarter),
        environment: [
          {
            name: "CONFIG",
            source: "literal",
            value: ["hf", "not-a-real-token-value"].join("_"),
          },
        ],
      }),
    ).toThrow("credential");
    expect(() =>
      compileAgentWorkbenchRecipe({
        ...structuredClone(fastAgentWorkbenchStarter),
        environment: [{ name: "GITHUB_TOKEN", source: "workspace_path" }],
      }),
    ).toThrow("credential-like");
    expect(() =>
      compileAgentWorkbenchRecipe({
        ...structuredClone(fastAgentWorkbenchStarter),
        environment: [{ name: "HARBOR_CONTROL", source: "literal", value: "value" }],
      }),
    ).toThrow("reserved");
    expect(() =>
      compileAgentWorkbenchRecipe({
        ...structuredClone(fastAgentWorkbenchStarter),
        outputs: {
          results_path: "/logs/agent/result.json",
          trajectory_path: "/logs/agent/result.json",
        },
      }),
    ).toThrow("must not duplicate");
    expect(() =>
      compileAgentWorkbenchRecipe({
        ...structuredClone(fastAgentWorkbenchStarter),
        outputs: {
          results_path: "/logs/agent/result.json",
          trajectory_path: "/logs/agent/trajectory.txt",
        },
      }),
    ).toThrow("must end in .json");
  });

  it("keeps instructions as a path binding instead of command text", () => {
    const preview = compileAgentWorkbenchRecipe(fastAgentWorkbenchStarter);
    expect(preview.run_command).toContain("/run/agent/instruction.txt");
    expect(JSON.stringify(preview.harbor_agent)).not.toContain("Setup test only");
  });

  it("rejects run-only bindings from setup", () => {
    expect(() =>
      compileAgentWorkbenchRecipe({
        ...structuredClone(fastAgentWorkbenchStarter),
        setup_command: 'curl "$MODEL_BASE_URL"',
      }),
    ).toThrow("run-only environment variable MODEL_BASE_URL");
  });
});
