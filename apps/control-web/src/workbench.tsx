import { useEffect, useState } from "react";
import type { WorkbenchRecipe, SavedConfiguration } from "./api";
import { listSavedConfigurations, saveConfiguration } from "./api";
import { PageHeader } from "./layout";
import { Button, Card, ErrorNotice } from "./ui";
import { useControlState } from "./control-state";

export const fastAgentStarter: WorkbenchRecipe = {
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

export const fxStarter: WorkbenchRecipe = {
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

export function WorkbenchPage() {
  const { writesAllowed } = useControlState();
  const [name, setName] = useState("my-harness");
  const [text, setText] = useState(
    '{"agents": [{"name": "terminus-2", "kwargs": {}}]}',
  );
  const [items, setItems] = useState<SavedConfiguration[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    void listSavedConfigurations()
      .then((value) => setItems(value.items))
      .catch(setError);
  }, []);
  async function save() {
    try {
      const item = await saveConfiguration({
        name,
        harbor_job_config: JSON.parse(text),
      });
      setItems((current) => [
        ...current.filter((value) => value.revision !== item.revision),
        item,
      ]);
      setSelected(item.revision);
      setMessage("Saved immutable harness version. No Job was launched.");
      setError(null);
    } catch (failure) {
      setError(failure);
    }
  }
  return (
    <>
      <PageHeader
        title="Agent Workbench"
        description="Configure, save, and load named immutable Harbor JobConfig fragments."
      />
      <Card>
        <p role="status">
          Execution disabled: a supported Harbor runner and isolated credential boundary
          are not yet available. Remote setup tests and launch are unavailable.
        </p>
        <p className="my-4">
          Use native Harbor agent settings, including installation commands in your
          agent kwargs. Discover options with harbor agents list --json and harbor
          agents schema NAME --json. Never enter secrets. Saving is not execution
          approval.
        </p>
        <label className="block">
          Harness name
          <input
            className="block w-full bg-slate-950 p-2"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="block mt-4">
          Harbor JobConfig fragment
          <textarea
            className="block w-full bg-slate-950 p-2 font-mono"
            rows={16}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <div className="mt-4 flex gap-3">
          <Button disabled={!writesAllowed} onClick={() => void save()}>
            Save configuration
          </Button>
          <Button disabled>Test setup</Button>
          <Button disabled>Launch Harbor run</Button>
        </div>
        <label className="block mt-4">
          Load configuration
          <select
            className="block w-full bg-slate-950 p-2"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Select a saved version</option>
            {items.map((item) => (
              <option key={item.revision} value={item.revision}>
                {item.name} · {item.revision.slice(7, 15)}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={!selected}
          onClick={() => {
            const item = items.find((value) => value.revision === selected);
            if (item) {
              setName(item.name);
              setText(JSON.stringify(item.harbor_job_config, null, 2));
              setMessage("Loaded exact saved version; execution remains disabled.");
            }
          }}
        >
          Load
        </Button>
        {message ? <p role="status">{message}</p> : null}
        {error ? <ErrorNotice error={error} /> : null}
      </Card>
    </>
  );
}
