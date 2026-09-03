import type { AgentWorkbenchRecipeV1, HarnessProfileSpec } from "@harbor-hf/contracts";
import {
  canonicalJson,
  deterministicId,
  sha256,
  validateAgentWorkbenchRecipe,
} from "@harbor-hf/contracts";

const reservedEnvironment = new Set([
  "BASH_ENV",
  "CDPATH",
  "DEBIAN_FRONTEND",
  "ENV",
  "HOME",
  "IFS",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LOGNAME",
  "NVM_DIR",
  "OLDPWD",
  "PATH",
  "PROMPT_COMMAND",
  "PS4",
  "PWD",
  "PYTHONHOME",
  "PYTHONPATH",
  "SHELL",
  "USER",
  "HF_TOKEN",
  "HF_INFERENCE_TOKEN",
  "HARBOR_HF_WORKER_CAPABILITY",
]);

const secretName =
  /(?:^|_)(?:API_?KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIALS?|AUTH|COOKIE|PRIVATE_?KEY)(?:_|$)/i;
const suspiciousLiteral =
  /(?:\bBearer\s+[A-Za-z0-9._~+/-]{12,}|hf[_-][A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|\bAKIA[A-Z0-9]{12,})/i;

export const agentWorkbenchCompilerRevision = "agent-workbench-compiler-v1";

export const workbenchRuntimeValues = {
  instruction_path: "/run/agent/instruction.txt",
  workspace_path: "/app",
  logs_path: "/logs/agent",
  agent_home: "/logs/agent/home",
  model_name: "<locked-model-route>",
  model_base_url: "<injected-model-base-url>",
  model_api_key: "<injected-model-api-key>",
} as const;

export interface WorkbenchPreviewEnvironment {
  name: string;
  source: AgentWorkbenchRecipeV1["environment"][number]["source"];
  value: string;
  redacted: boolean;
}

export interface AgentWorkbenchPreview {
  recipe: AgentWorkbenchRecipeV1;
  recipe_digest: string;
  revision_id: string;
  setup_command: string;
  run_command: string;
  environment: WorkbenchPreviewEnvironment[];
  harness_profile: HarnessProfileSpec;
  warnings: string[];
}

export const fastAgentWorkbenchStarter: AgentWorkbenchRecipeV1 = {
  schema_version: "v1",
  name: "fast-agent",
  setup_command: [
    "set -eu",
    "uv_version=0.12.5",
    "uv_sha256=68a509da24b06b4223a1c0175fb5eb5bc79342b76cbeff0cfe51ac3f5b17b6b2",
    "python_version=3.12.14",
    'case "$(uname -m)" in',
    "  x86_64|amd64) uv_target=x86_64-unknown-linux-gnu ;;",
    '  *) printf "unsupported setup architecture\\n" >&2; exit 2 ;;',
    "esac",
    "command -v /usr/lib/apt/apt-helper >/dev/null 2>&1",
    "command -v tar >/dev/null 2>&1",
    "command -v sha256sum >/dev/null 2>&1",
    'mkdir -p "$AGENT_HOME/bin" "$AGENT_HOME/cache" "$AGENT_HOME/python"',
    `uv_archive="$AGENT_HOME/cache/uv-\${uv_version}.tar.gz"`,
    'uv_download_log="$AGENT_HOME/cache/uv-download.log"',
    "if ! /usr/lib/apt/apt-helper \\",
    "  -o Acquire::https::Verify-Peer=false \\",
    "  -o Acquire::https::Verify-Host=false \\",
    "  download-file \\",
    `  "https://github.com/astral-sh/uv/releases/download/\${uv_version}/uv-\${uv_target}.tar.gz" \\`,
    '  "$uv_archive" >"$uv_download_log" 2>&1',
    "then",
    '  printf "pinned uv download failed\\n" >&2',
    "  exit 1",
    "fi",
    'printf "%s  %s\\n" "$uv_sha256" "$uv_archive" |',
    "  sha256sum --check --strict",
    'rm -rf "$AGENT_HOME/cache/uv-extract"',
    'mkdir -p "$AGENT_HOME/cache/uv-extract"',
    'tar -xzf "$uv_archive" \\',
    '  -C "$AGENT_HOME/cache/uv-extract" \\',
    "  --strip-components=1",
    'install -m 0755 "$AGENT_HOME/cache/uv-extract/uv" "$AGENT_HOME/bin/uv"',
    'UV_CACHE_DIR="$AGENT_HOME/cache/uv" \\',
    'UV_PYTHON_INSTALL_DIR="$AGENT_HOME/python" \\',
    "UV_NO_PROGRESS=1 \\",
    '  "$AGENT_HOME/bin/uv" python install "$python_version"',
    'UV_CACHE_DIR="$AGENT_HOME/cache/uv" \\',
    'UV_PYTHON_INSTALL_DIR="$AGENT_HOME/python" \\',
    "UV_NO_PROGRESS=1 \\",
    '  "$AGENT_HOME/bin/uv" venv \\',
    '  --python "$python_version" \\',
    "  --python-preference only-managed \\",
    '  "$AGENT_HOME/venv"',
    'UV_CACHE_DIR="$AGENT_HOME/cache/uv" \\',
    'UV_PYTHON_INSTALL_DIR="$AGENT_HOME/python" \\',
    "UV_NO_PROGRESS=1 \\",
    '  "$AGENT_HOME/bin/uv" pip install \\',
    '  --python "$AGENT_HOME/venv/bin/python" \\',
    "  fast-agent-mcp==0.10.16",
    '"$AGENT_HOME/venv/bin/python" --version',
    '"$AGENT_HOME/venv/bin/fast-agent" --version',
  ].join("\n"),
  run_command: [
    '"$AGENT_HOME/venv/bin/fast-agent" go',
    '  --model "$AGENT_MODEL"',
    '  --base-url "$MODEL_BASE_URL"',
    '  --prompt-file "$TASK_INSTRUCTION_PATH"',
    '  --workspace "$TASK_WORKSPACE"',
    '  --home "$AGENT_HOME/runtime"',
    '  --results "$AGENT_RESULTS_PATH"',
    '  --trajectory-output "$AGENT_TRAJECTORY_PATH"',
    "  --shell",
    "  --quiet",
  ].join(" \\\n"),
  route_api: "chat-completions",
  setup_timeout_seconds: 1800,
  environment: [
    { name: "AGENT_HOME", source: "agent_home" },
    { name: "AGENT_MODEL", source: "model_name" },
    { name: "OPENAI_API_KEY", source: "model_api_key" },
    { name: "MODEL_BASE_URL", source: "model_base_url" },
    {
      name: "AGENT_RESULTS_PATH",
      source: "literal",
      value: "/logs/agent/fast-agent-results.json",
    },
    {
      name: "AGENT_TRAJECTORY_PATH",
      source: "literal",
      value: "/logs/agent/trajectory.json",
    },
    { name: "TASK_INSTRUCTION_PATH", source: "instruction_path" },
    { name: "TASK_WORKSPACE", source: "workspace_path" },
  ],
  outputs: {
    results_path: "/logs/agent/fast-agent-results.json",
    trajectory_path: "/logs/agent/trajectory.json",
  },
};

export const fxWorkbenchStarter: AgentWorkbenchRecipeV1 = {
  schema_version: "v1",
  name: "fx",
  setup_command: [
    "set -eu",
    "fx_version=0.0.6",
    'case "$(uname -m)" in',
    "  x86_64|amd64)",
    "    fx_target=x86_64",
    "    fx_sha256=120fa992df8caf982e17ca9e9e3966c790b0d150480511eaf51392e66a0f0b84",
    "    ;;",
    "  aarch64|arm64)",
    "    fx_target=aarch64",
    "    fx_sha256=0dfd53224c5ecede601bb8ce649f84fab6db05a39afbcd5b39e6091833f6c4d7",
    "    ;;",
    '  *) printf "unsupported setup architecture\\n" >&2; exit 2 ;;',
    "esac",
    "command -v /usr/lib/apt/apt-helper >/dev/null 2>&1",
    "command -v tar >/dev/null 2>&1",
    "command -v sha256sum >/dev/null 2>&1",
    'mkdir -p "$AGENT_HOME/bin" "$AGENT_HOME/cache"',
    `fx_archive="$AGENT_HOME/cache/fx-\${fx_version}-\${fx_target}.tar.gz"`,
    'fx_download_log="$AGENT_HOME/cache/fx-download.log"',
    "if ! /usr/lib/apt/apt-helper \\",
    "  -o Acquire::https::Verify-Peer=false \\",
    "  -o Acquire::https::Verify-Host=false \\",
    "  download-file \\",
    `  "https://releases.fx.sh/v\${fx_version}/fx-linux-\${fx_target}.tar.gz" \\`,
    '  "$fx_archive" >"$fx_download_log" 2>&1',
    "then",
    '  printf "pinned FX download failed\\n" >&2',
    "  exit 1",
    "fi",
    'printf "%s  %s\\n" "$fx_sha256" "$fx_archive" |',
    "  sha256sum --check --strict",
    'tar -xzf "$fx_archive" -C "$AGENT_HOME/bin" fx',
    'chmod 0755 "$AGENT_HOME/bin/fx"',
    '"$AGENT_HOME/bin/fx" --version',
  ].join("\n"),
  run_command: [
    'cd "$TASK_WORKSPACE"',
    '"$AGENT_HOME/bin/fx" ask --yolo --json -- "$(cat "$TASK_INSTRUCTION_PATH")"',
    '  < /dev/null > "$AGENT_RESULTS_PATH"',
  ].join(" \\\n"),
  route_api: "chat-completions",
  setup_timeout_seconds: 600,
  environment: [
    { name: "AGENT_HOME", source: "agent_home" },
    { name: "FX_MODEL", source: "model_name" },
    { name: "AI_GATEWAY_API_KEY", source: "model_api_key" },
    { name: "FX_AUTO_UPGRADE", source: "literal", value: "0" },
    {
      name: "AGENT_RESULTS_PATH",
      source: "literal",
      value: "/logs/agent/fx-results.json",
    },
    { name: "TASK_INSTRUCTION_PATH", source: "instruction_path" },
    { name: "TASK_WORKSPACE", source: "workspace_path" },
  ],
  outputs: {
    results_path: "/logs/agent/fx-results.json",
    trajectory_path: null,
  },
};

function quoteShell(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function expandSimpleEnvironment(
  command: string,
  environment: ReadonlyMap<string, string>,
): string {
  return command.replace(
    /\$(?:\{([A-Z_][A-Z0-9_]*)\}|([A-Z_][A-Z0-9_]*))/g,
    (match, braced: string | undefined, plain: string | undefined) => {
      const name = braced ?? plain;
      if (!name || !environment.has(name)) return match;
      return quoteShell(environment.get(name) as string);
    },
  );
}

function validateRecipeSemantics(recipe: AgentWorkbenchRecipeV1): void {
  if (recipe.setup_command.includes("\0") || recipe.run_command.includes("\0"))
    throw new Error("commands must not contain NUL characters");
  if (
    suspiciousLiteral.test(recipe.setup_command) ||
    suspiciousLiteral.test(recipe.run_command)
  )
    throw new Error("commands must not contain credential-like values");
  const names = new Set<string>();
  const sources = new Map<
    string,
    AgentWorkbenchRecipeV1["environment"][number]["source"]
  >();
  for (const binding of recipe.environment) {
    if (names.has(binding.name))
      throw new Error(`environment variable ${binding.name} is duplicated`);
    names.add(binding.name);
    sources.set(binding.name, binding.source);
    if (reservedEnvironment.has(binding.name) || binding.name.startsWith("HARBOR_"))
      throw new Error(`environment variable ${binding.name} is reserved`);
    if (secretName.test(binding.name) && binding.source !== "model_api_key")
      throw new Error(`environment variable ${binding.name} looks credential-like`);
    if (binding.source === "literal") {
      if (binding.value === undefined)
        throw new Error(`literal environment variable ${binding.name} needs a value`);
      if (suspiciousLiteral.test(binding.value ?? ""))
        throw new Error(
          `literal environment variable ${binding.name} looks like a credential`,
        );
      if ((binding.value ?? "").includes("\0"))
        throw new Error(
          `literal environment variable ${binding.name} must not contain NUL`,
        );
    } else if (binding.value !== undefined)
      throw new Error(
        `runtime environment variable ${binding.name} must not declare a literal value`,
      );
  }
  const setupOnlyUnavailable = new Set([
    "instruction_path",
    "model_base_url",
    "model_api_key",
  ]);
  for (const match of recipe.setup_command.matchAll(
    /\$(?:\{([A-Z_][A-Z0-9_]*)\}|([A-Z_][A-Z0-9_]*))/g,
  )) {
    const name = match[1] ?? match[2];
    const source = name ? sources.get(name) : undefined;
    if (source && setupOnlyUnavailable.has(source))
      throw new Error(`setup command cannot use run-only environment variable ${name}`);
  }
  for (const path of [
    recipe.outputs.results_path,
    recipe.outputs.trajectory_path,
  ].filter((value): value is string => value !== null)) {
    if (path.includes("..") || path.includes("//"))
      throw new Error("output paths must remain beneath /logs/agent");
  }
  if (
    recipe.outputs.trajectory_path !== null &&
    !recipe.outputs.trajectory_path.endsWith(".json")
  )
    throw new Error("ATIF trajectory path must end in .json");
  if (recipe.outputs.trajectory_path === recipe.outputs.results_path)
    throw new Error("ATIF trajectory path must not duplicate the results path");
}

function commandAgentConfig(recipe: AgentWorkbenchRecipeV1): Record<string, unknown> {
  const bindings: Record<string, string> = {};
  const literals: Record<string, string> = {};
  const bindingNames = {
    instruction_path: "instruction_path",
    workspace_path: "workspace_path",
    logs_path: "logs_path",
    agent_home: "agent_home",
    model_name: "model_name",
    model_base_url: "model_base_url",
    model_api_key: "model_api_key",
  } as const;
  for (const item of recipe.environment) {
    if (item.source === "literal") literals[item.name] = item.value ?? "";
    else bindings[item.name] = bindingNames[item.source];
  }
  return {
    schema_version: "v1",
    setup: {
      script: recipe.setup_command,
      bindings: Object.fromEntries(
        Object.entries(bindings).filter(([, value]) =>
          ["workspace_path", "logs_path", "agent_home", "model_name"].includes(value),
        ),
      ),
      literals,
    },
    run: {
      script: recipe.run_command,
      bindings,
      literals,
    },
    route_api: recipe.route_api,
    outputs: [
      {
        path: recipe.outputs.results_path.replace(/^\/logs\/agent\//, ""),
      },
    ],
    ...(recipe.outputs.trajectory_path
      ? {
          atif: {
            path: recipe.outputs.trajectory_path.replace(/^\/logs\/agent\//, ""),
          },
        }
      : {}),
  };
}

export function compileAgentWorkbenchRecipe(value: unknown): AgentWorkbenchPreview {
  const recipe = validateAgentWorkbenchRecipe<AgentWorkbenchRecipeV1>(
    structuredClone(value),
  );
  validateRecipeSemantics(recipe);
  const environment = recipe.environment
    .map((binding) => {
      const redacted = binding.source === "model_api_key";
      return {
        name: binding.name,
        source: binding.source,
        value:
          binding.source === "literal"
            ? (binding.value ?? "")
            : workbenchRuntimeValues[binding.source],
        redacted,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const values = new Map(environment.map((item) => [item.name, item.value]));
  const recipeDigest = sha256(canonicalJson(recipe));
  const requiredEvidence = ["workspace", "verifier"];
  if (recipe.outputs.trajectory_path) requiredEvidence.push("trajectory");
  return {
    recipe,
    recipe_digest: recipeDigest,
    revision_id: deterministicId(
      "agent-recipe",
      agentWorkbenchCompilerRevision,
      recipe.name,
      recipeDigest,
    ),
    setup_command: expandSimpleEnvironment(recipe.setup_command, values),
    run_command: expandSimpleEnvironment(recipe.run_command, values),
    environment,
    harness_profile: {
      contract_version: "v1",
      agent: "command-agent",
      revision: recipeDigest,
      reasoning_effort: "off",
      required_evidence: requiredEvidence,
      capabilities: {
        inference_apis: [recipe.route_api],
      },
      harbor_agent: {
        import_path: "harbor_hf_agents.command_agent.agent:CommandAgent",
        override_setup_timeout_sec: recipe.setup_timeout_seconds,
        kwargs: {
          config: commandAgentConfig(recipe),
        },
      },
    },
    warnings: recipe.outputs.trajectory_path
      ? []
      : ["No ATIF trajectory is declared; results remain diagnostic."],
  };
}
