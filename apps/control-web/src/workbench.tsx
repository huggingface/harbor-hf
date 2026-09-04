import {
  CheckCircle2,
  FlaskConical,
  LoaderCircle,
  PlayCircle,
  Plus,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  cancelWorkbenchSetup,
  getWorkbenchFile,
  getWorkbenchLogs,
  getWorkbenchSetup,
  listWorkbenchSetups,
  previewWorkbenchRecipe,
  startWorkbenchSetup,
  submitRun,
  type WorkbenchFile,
  type WorkbenchPreview,
  type WorkbenchRecipe,
  type WorkbenchSetup,
} from "./api";
import { useControlState } from "./control-state";
import { PageHeader } from "./layout";
import { cn, formatDate, formatMoneyUsd } from "./lib";
import { usePresets, useSystem } from "./queries";
import { Badge, Button, Card, ErrorNotice, Loading } from "./ui";

const sources = [
  "literal",
  "instruction_path",
  "workspace_path",
  "logs_path",
  "agent_home",
  "model_name",
  "model_base_url",
  "model_api_key",
] as const;

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

function copyStarter(starter: WorkbenchRecipe = fastAgentStarter): WorkbenchRecipe {
  return structuredClone(starter);
}

function fieldClass(invalid = false): string {
  return cn(
    "w-full rounded-lg border bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:ring-2 focus:ring-cyan-400",
    invalid ? "border-rose-500" : "border-slate-700",
  );
}

function statusTone(status: WorkbenchSetup["status"]): string {
  if (status === "passed") return "complete";
  if (status === "cancelled" || status === "failed" || status === "timed-out")
    return "error";
  return "active";
}

function WorkbenchFlow() {
  const stages = [
    [
      "Configure",
      "Edit the generic command recipe and review its compiled Harbor agent.",
    ],
    [
      "Test",
      "Install this exact recipe in a disposable CPU sandbox. No model request is made.",
    ],
    [
      "Run",
      "Select normal run settings and submit the tested recipe through the standard Harbor path.",
    ],
  ] as const;
  return (
    <Card className="mb-6">
      <h2 className="font-semibold text-white">Configure → Test → Run</h2>
      <ol className="mt-4 grid gap-3 md:grid-cols-3">
        {stages.map(([title, description], index) => (
          <li className="rounded-lg border border-slate-800 p-3" key={title}>
            <div className="flex items-center gap-2">
              <Badge status="active">{index + 1}</Badge>
              <span className="font-medium text-slate-100">{title}</span>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-400">{description}</p>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-sm text-slate-300">
        Setup receives no benchmark, model route, inference credential, Bucket mount, or
        worker authority. A passed setup is valid for one hour and only for the same
        actor and exact recipe digest.
      </p>
    </Card>
  );
}

function terminalSetup(status: WorkbenchSetup["status"]): boolean {
  return ["cancelled", "passed", "failed", "timed-out"].includes(status);
}

export function WorkbenchPage() {
  const navigate = useNavigate();
  const { actor, writesAllowed } = useControlState();
  const system = useSystem();
  const presets = usePresets();
  const [recipe, setRecipe] = useState<WorkbenchRecipe>(copyStarter);
  const [preview, setPreview] = useState<WorkbenchPreview | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);
  const [setup, setSetup] = useState<WorkbenchSetup | null>(null);
  const [setupError, setSetupError] = useState<unknown>(null);
  const [startingSetup, setStartingSetup] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [logs, setLogs] = useState({ stdout: "", stderr: "" });
  const [selectedFile, setSelectedFile] = useState<WorkbenchFile | null>(null);
  const [fileContent, setFileContent] = useState<{
    content: string;
    truncated: boolean;
  } | null>(null);
  const [fileError, setFileError] = useState<unknown>(null);
  const [benchmarkKey, setBenchmarkKey] = useState("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [ceiling, setCeiling] = useState("1");
  const [role, setRole] = useState<"final" | "diagnostic">("diagnostic");
  const [launchConfirmed, setLaunchConfirmed] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<unknown>(null);
  const previewSequence = useRef(0);
  const activeSetupRef = useRef<HTMLDivElement | null>(null);
  const liveOutputRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    void listWorkbenchSetups()
      .then((setups) => {
        if (setups[0]) setSetup(setups[0]);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const first = presets.data?.benchmarks[0];
    if (first && !benchmarkKey) setBenchmarkKey(`${first.benchmark}\n${first.preset}`);
  }, [benchmarkKey, presets.data]);

  useEffect(() => {
    const sequence = ++previewSequence.current;
    setChecking(true);
    const timeout = window.setTimeout(() => {
      void previewWorkbenchRecipe(recipe)
        .then((value) => {
          if (sequence !== previewSequence.current) return;
          setPreview(value);
          setPreviewError(null);
        })
        .catch((error: unknown) => {
          if (sequence !== previewSequence.current) return;
          setPreview(null);
          setPreviewError(error);
        })
        .finally(() => {
          if (sequence === previewSequence.current) setChecking(false);
        });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [recipe]);

  useEffect(() => {
    if (!setup || terminalSetup(setup.status)) return;
    const timer = window.setInterval(() => {
      void getWorkbenchSetup(setup.setup_test_id).then(setSetup).catch(setSetupError);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [setup]);

  useEffect(() => {
    if (!setup) return;
    const load = () =>
      void getWorkbenchLogs(setup.setup_test_id)
        .then((value) => {
          setLogs(value);
          setSetupError(null);
        })
        .catch(setSetupError);
    load();
    if (terminalSetup(setup.status)) return;
    const timer = window.setInterval(load, 1_000);
    return () => window.clearInterval(timer);
  }, [setup]);

  useEffect(() => {
    if (!liveOutputRef.current || !setup || terminalSetup(setup.status)) return;
    void logs.stdout;
    void logs.stderr;
    liveOutputRef.current.scrollTop = liveOutputRef.current.scrollHeight;
  }, [logs, setup]);

  const setupMatches = Boolean(
    setup &&
      preview &&
      setup.status === "passed" &&
      setup.exit_code === 0 &&
      setup.recipe_digest === preview.recipe_digest &&
      setup.revision_id === preview.revision_id,
  );
  const setupCanStart = Boolean(
    system.data?.workbench.setup_enabled &&
      (system.data.workbench.runner === "docker" || writesAllowed),
  );
  const hasDirectRoute =
    recipe.environment.some((binding) => binding.source === "model_base_url") &&
    recipe.environment.some((binding) => binding.source === "model_api_key");
  const liveOutput = `${logs.stdout}${logs.stderr ? `\n[stderr]\n${logs.stderr}` : ""}`;

  function changeRecipe(next: WorkbenchRecipe) {
    setRecipe(next);
    setConfirmed(false);
    setLaunchConfirmed(false);
    setSelectedFile(null);
    setFileContent(null);
  }

  function updateEnvironment(
    index: number,
    next: WorkbenchRecipe["environment"][number],
  ) {
    changeRecipe({
      ...recipe,
      environment: recipe.environment.map((item, itemIndex) =>
        itemIndex === index ? next : item,
      ),
    });
  }

  async function startSetup() {
    if (!confirmed || !preview || !setupCanStart) return;
    setStartingSetup(true);
    setSetupError(null);
    try {
      const value = await startWorkbenchSetup(recipe);
      setSetup(value);
      setLogs({ stdout: "", stderr: "" });
      setConfirmed(false);
      window.setTimeout(
        () => activeSetupRef.current?.scrollIntoView?.({ behavior: "smooth" }),
        0,
      );
    } catch (error) {
      setSetupError(error);
    } finally {
      setStartingSetup(false);
    }
  }

  async function cancelSetup() {
    if (!setup) return;
    setCancelling(true);
    setSetupError(null);
    try {
      setSetup(await cancelWorkbenchSetup(setup.setup_test_id));
    } catch (error) {
      setSetupError(error);
    } finally {
      setCancelling(false);
    }
  }

  async function openFile(file: WorkbenchFile) {
    if (!setup || !file.text) return;
    setSelectedFile(file);
    setFileContent(null);
    setFileError(null);
    try {
      setFileContent(await getWorkbenchFile(setup.setup_test_id, file.file_id));
    } catch (error) {
      setFileError(error);
    }
  }

  async function launch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !setup ||
      !setupMatches ||
      !launchConfirmed ||
      !writesAllowed ||
      !hasDirectRoute
    )
      return;
    const [benchmark, preset] = benchmarkKey.split("\n");
    if (!(benchmark && preset && model.trim() && provider.trim())) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      const response = await submitRun({
        benchmark: { name: benchmark, preset },
        model: {
          id: model.trim(),
          provider: provider.trim(),
          reasoning_effort: "off",
        },
        cost_ceiling_usd_per_trial: Number(ceiling),
        role,
        workbench: { recipe, setup_test_id: setup.setup_test_id },
      });
      navigate(`/runs/${response.run.run_id}`);
    } catch (error) {
      setLaunchError(error);
    } finally {
      setLaunching(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Agent Workbench"
        description="Author and setup-test a generic command-line Harbor agent, then launch the exact tested recipe through one normal Run."
      />
      <WorkbenchFlow />
      <div className="grid gap-6 2xl:grid-cols-[minmax(0,1.2fr)_minmax(24rem,0.8fr)]">
        <div className="space-y-6">
          <Card>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="font-semibold text-white">1. Configure</h2>
                <p className="mt-1 text-sm text-slate-400">
                  Start from a retained recipe or edit every typed field.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => changeRecipe(copyStarter(fastAgentStarter))}
                >
                  <RotateCcw size={14} aria-hidden="true" /> Fast Agent
                </Button>
                <Button
                  variant="outline"
                  onClick={() => changeRecipe(copyStarter(fxStarter))}
                >
                  <RotateCcw size={14} aria-hidden="true" /> FX
                </Button>
              </div>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              <label className="text-sm text-slate-300">
                Recipe name
                <input
                  className={fieldClass()}
                  value={recipe.name}
                  onChange={(event) =>
                    changeRecipe({ ...recipe, name: event.target.value })
                  }
                />
              </label>
              <label className="text-sm text-slate-300">
                Inference API
                <select
                  className={fieldClass()}
                  value={recipe.route_api}
                  onChange={(event) =>
                    changeRecipe({
                      ...recipe,
                      route_api: event.target.value as WorkbenchRecipe["route_api"],
                    })
                  }
                >
                  <option value="chat-completions">Chat Completions</option>
                  <option value="responses">Responses</option>
                </select>
              </label>
              <label className="text-sm text-slate-300">
                Setup timeout (seconds)
                <input
                  className={fieldClass()}
                  min={30}
                  max={3600}
                  type="number"
                  value={recipe.setup_timeout_seconds}
                  onChange={(event) =>
                    changeRecipe({
                      ...recipe,
                      setup_timeout_seconds: Number(event.target.value),
                    })
                  }
                />
              </label>
            </div>
            <label className="mt-4 block text-sm text-slate-300">
              Setup command
              <textarea
                className={`${fieldClass()} min-h-52 font-mono text-xs leading-5`}
                value={recipe.setup_command}
                onChange={(event) =>
                  changeRecipe({ ...recipe, setup_command: event.target.value })
                }
              />
            </label>
            <label className="mt-4 block text-sm text-slate-300">
              Run command
              <textarea
                className={`${fieldClass()} min-h-32 font-mono text-xs leading-5`}
                value={recipe.run_command}
                onChange={(event) =>
                  changeRecipe({ ...recipe, run_command: event.target.value })
                }
              />
            </label>
            <div className="mt-5 flex items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-medium text-white">Environment bindings</h3>
                <p className="mt-1 text-xs text-slate-500">
                  Model route and key bindings are injected only during the Harbor
                  trial.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() =>
                  changeRecipe({
                    ...recipe,
                    environment: [
                      ...recipe.environment,
                      { name: "NEW_VALUE", source: "literal", value: "" },
                    ],
                  })
                }
              >
                <Plus size={14} aria-hidden="true" /> Add
              </Button>
            </div>
            <div className="mt-3 space-y-2">
              {recipe.environment.map((binding, index) => (
                <div
                  className="grid gap-2 rounded-lg border border-slate-800 p-3 sm:grid-cols-[1fr_1fr_1.25fr_auto]"
                  key={binding.name}
                >
                  <input
                    aria-label={`Binding ${index + 1} name`}
                    className={fieldClass()}
                    value={binding.name}
                    onChange={(event) =>
                      updateEnvironment(index, { ...binding, name: event.target.value })
                    }
                  />
                  <select
                    aria-label={`Binding ${index + 1} source`}
                    className={fieldClass()}
                    value={binding.source}
                    onChange={(event) => {
                      const source = event.target.value as (typeof sources)[number];
                      updateEnvironment(
                        index,
                        source === "literal"
                          ? { name: binding.name, source, value: "" }
                          : { name: binding.name, source },
                      );
                    }}
                  >
                    {sources.map((source) => (
                      <option key={source}>{source}</option>
                    ))}
                  </select>
                  {binding.source === "literal" ? (
                    <input
                      aria-label={`Binding ${index + 1} value`}
                      className={fieldClass()}
                      value={binding.value ?? ""}
                      onChange={(event) =>
                        updateEnvironment(index, {
                          ...binding,
                          value: event.target.value,
                        })
                      }
                    />
                  ) : (
                    <span className="self-center text-xs text-slate-500">
                      Managed at run time
                    </span>
                  )}
                  <Button
                    aria-label={`Remove binding ${binding.name}`}
                    variant="ghost"
                    onClick={() =>
                      changeRecipe({
                        ...recipe,
                        environment: recipe.environment.filter(
                          (_, itemIndex) => itemIndex !== index,
                        ),
                      })
                    }
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-slate-300">
                Results path
                <input
                  className={fieldClass()}
                  value={recipe.outputs.results_path}
                  onChange={(event) =>
                    changeRecipe({
                      ...recipe,
                      outputs: { ...recipe.outputs, results_path: event.target.value },
                    })
                  }
                />
              </label>
              <label className="text-sm text-slate-300">
                ATIF trajectory path (optional)
                <input
                  className={fieldClass()}
                  value={recipe.outputs.trajectory_path ?? ""}
                  onChange={(event) =>
                    changeRecipe({
                      ...recipe,
                      outputs: {
                        ...recipe.outputs,
                        trajectory_path: event.target.value || null,
                      },
                    })
                  }
                />
              </label>
            </div>
          </Card>

          <Card>
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="font-semibold text-white">Compiled preview</h2>
                <p className="mt-1 text-sm text-slate-400">
                  This is the secret-free command agent that Harbor will receive.
                </p>
              </div>
              {checking ? (
                <LoaderCircle className="animate-spin text-cyan-300" size={18} />
              ) : null}
            </div>
            {previewError ? (
              <div className="mt-4">
                <ErrorNotice error={previewError} />
              </div>
            ) : null}
            {preview ? (
              <div className="mt-4 space-y-4">
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-slate-500">Recipe digest</dt>
                    <dd className="mt-1 break-all font-mono text-xs text-slate-200">
                      {preview.recipe_digest}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Compiler revision</dt>
                    <dd className="mt-1 break-all font-mono text-xs text-slate-200">
                      {preview.revision_id}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Harbor import</dt>
                    <dd className="mt-1 break-all font-mono text-xs text-slate-200">
                      {preview.harbor_agent.import_path}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Setup timeout</dt>
                    <dd className="mt-1 text-slate-200">
                      {preview.harbor_agent.override_setup_timeout_sec}s
                    </dd>
                  </div>
                </dl>
                {preview.warnings.map((warning) => (
                  <p
                    className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-200"
                    key={warning}
                  >
                    {warning}
                  </p>
                ))}
                <details className="rounded-lg border border-slate-800">
                  <summary className="cursor-pointer px-3 py-2 text-sm text-slate-300">
                    Resolved commands and bindings
                  </summary>
                  <pre className="max-h-80 overflow-auto border-t border-slate-800 p-3 text-xs text-slate-300">
                    {JSON.stringify(
                      {
                        setup_command: preview.setup_command,
                        run_command: preview.run_command,
                        environment: preview.environment,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </div>
            ) : null}
          </Card>
        </div>

        <div className="space-y-6">
          <div ref={activeSetupRef}>
            <Card>
              <h2 className="font-semibold text-white">2. Test setup</h2>
              <p className="mt-1 text-sm text-slate-400">
                Runner: {system.data ? system.data.workbench.runner : "loading"}. The
                setup command cannot access the inference credential.
              </p>
              {!system.data ? (
                <div className="mt-4">
                  <Loading />
                </div>
              ) : null}
              {system.error ? (
                <div className="mt-4">
                  <ErrorNotice error={system.error} />
                </div>
              ) : null}
              {!setupCanStart && system.data ? (
                <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-200">
                  Setup testing is not available in the current runner or write mode.
                </p>
              ) : null}
              <label className="mt-4 flex items-start gap-2 text-sm text-slate-300">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                Start one disposable CPU setup test for this exact recipe.
              </label>
              <Button
                className="mt-4 w-full"
                disabled={!confirmed || !preview || !setupCanStart || startingSetup}
                onClick={() => void startSetup()}
              >
                <FlaskConical size={15} aria-hidden="true" />
                {startingSetup ? "Starting" : "Run setup test"}
              </Button>
              {setupError ? (
                <div className="mt-4">
                  <ErrorNotice error={setupError} />
                </div>
              ) : null}
              {setup ? (
                <div className="mt-5 space-y-4 border-t border-slate-800 pt-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-mono text-xs text-slate-400">
                        {setup.setup_test_id}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        Started {formatDate(setup.started_at ?? setup.created_at)}
                      </p>
                    </div>
                    <Badge status={statusTone(setup.status)}>{setup.status}</Badge>
                  </div>
                  {!terminalSetup(setup.status) ? (
                    <Button
                      className="w-full"
                      variant="destructive"
                      disabled={cancelling}
                      onClick={() => void cancelSetup()}
                    >
                      <Square size={13} aria-hidden="true" />
                      {cancelling ? "Cancelling" : "Cancel setup"}
                    </Button>
                  ) : null}
                  {setup.status === "passed" ? (
                    <p className="flex items-center gap-2 text-sm text-emerald-300">
                      <CheckCircle2 size={16} aria-hidden="true" /> Setup passed
                    </p>
                  ) : null}
                  {setup.error ? (
                    <p className="text-sm text-rose-300">{setup.error}</p>
                  ) : null}
                  <div>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">
                      Output
                    </p>
                    <pre
                      ref={liveOutputRef}
                      className="max-h-72 min-h-24 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs leading-5 text-slate-300"
                    >
                      {liveOutput || "No output yet."}
                    </pre>
                  </div>
                  {setup.files.length > 0 ? (
                    <div>
                      <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">
                        Created files
                      </p>
                      <div className="space-y-1">
                        {setup.files.map((file) => (
                          <button
                            className="flex w-full items-center justify-between rounded-md border border-slate-800 px-3 py-2 text-left text-xs text-slate-300 hover:bg-slate-900 disabled:opacity-50"
                            disabled={!file.text}
                            key={file.file_id}
                            type="button"
                            onClick={() => void openFile(file)}
                          >
                            <span className="truncate">
                              {file.root}/{file.path}
                            </span>
                            <span className="ml-3 text-slate-600">{file.size} B</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {selectedFile ? (
                    <div>
                      <p className="mb-2 break-all text-xs text-slate-500">
                        {selectedFile.root}/{selectedFile.path}
                      </p>
                      {fileError ? <ErrorNotice error={fileError} /> : null}
                      {fileContent ? (
                        <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-300">
                          {fileContent.content}
                          {fileContent.truncated ? "\n[preview truncated]" : ""}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </Card>
          </div>

          <Card>
            <h2 className="font-semibold text-white">3. Run with Harbor</h2>
            <p className="mt-1 text-sm text-slate-400">
              This uses the normal Run record, parent Job, Harbor job folder, trial
              lifecycle, and cost stop.
            </p>
            {!setupMatches ? (
              <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-200">
                Pass setup for the current recipe before launch.
              </p>
            ) : null}
            {!hasDirectRoute ? (
              <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-200">
                Hosted launch requires both model_base_url and model_api_key bindings.
                This recipe can still be setup-tested.
              </p>
            ) : null}
            <form className="mt-4 space-y-4" onSubmit={(event) => void launch(event)}>
              <label className="block text-sm text-slate-300">
                Benchmark preset
                <select
                  className={fieldClass()}
                  required
                  value={benchmarkKey}
                  onChange={(event) => setBenchmarkKey(event.target.value)}
                >
                  {(presets.data?.benchmarks ?? []).map((item) => (
                    <option
                      key={`${item.benchmark}:${item.preset}`}
                      value={`${item.benchmark}\n${item.preset}`}
                    >
                      {item.benchmark} · {item.preset}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm text-slate-300">
                Model
                <input
                  className={fieldClass()}
                  maxLength={320}
                  placeholder="publisher/model"
                  required
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                />
              </label>
              <label className="block text-sm text-slate-300">
                Provider
                <input
                  className={fieldClass()}
                  pattern="[a-z0-9][a-z0-9-]{0,62}"
                  placeholder="provider"
                  required
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm text-slate-300">
                  Cost limit per trial
                  <input
                    className={fieldClass()}
                    min="0.000001"
                    max="10000"
                    step="0.000001"
                    type="number"
                    required
                    value={ceiling}
                    onChange={(event) => setCeiling(event.target.value)}
                  />
                </label>
                <label className="block text-sm text-slate-300">
                  Result role
                  <select
                    className={fieldClass()}
                    value={role}
                    onChange={(event) =>
                      setRole(event.target.value as "final" | "diagnostic")
                    }
                  >
                    <option value="diagnostic">Diagnostic</option>
                    <option value="final">Final</option>
                  </select>
                </label>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">
                <p>Agent: command-agent · {preview?.revision_id ?? "Unavailable"}</p>
                <p className="mt-1">
                  Maximum inference cost per completed trial:{" "}
                  {formatMoneyUsd(Number(ceiling))}
                </p>
                <p className="mt-1">Reasoning setting: Off</p>
              </div>
              <label className="flex items-start gap-2 text-sm text-slate-300">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={launchConfirmed}
                  onChange={(event) => setLaunchConfirmed(event.target.checked)}
                />
                Launch this exact tested recipe and accept the displayed per-trial cost
                limit.
              </label>
              {launchError ? <ErrorNotice error={launchError} /> : null}
              <Button
                className="w-full"
                disabled={
                  !setupMatches ||
                  !hasDirectRoute ||
                  !launchConfirmed ||
                  !writesAllowed ||
                  launching ||
                  actor.role !== "operator"
                }
                type="submit"
              >
                <PlayCircle size={16} aria-hidden="true" />
                {launching ? "Launching" : "Launch Harbor run"}
              </Button>
            </form>
          </Card>
        </div>
      </div>
    </>
  );
}
