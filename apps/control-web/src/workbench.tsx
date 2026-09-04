import {
  CheckCircle2,
  FlaskConical,
  LoaderCircle,
  PlayCircle,
  Plus,
  RotateCcw,
  Square,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  type BenchmarkConfig,
  cancelLocalHarborRun,
  cancelWorkbenchSetup,
  getBenchmarkConfigs,
  getLocalHarborLogs,
  getLocalHarborOptions,
  getLocalHarborRun,
  getWorkbenchFile,
  getWorkbenchLogs,
  getWorkbenchSetup,
  type LocalHarborOptions,
  type LocalHarborRun,
  listLocalHarborRuns,
  listWorkbenchSetups,
  previewLocalHarborConfig,
  previewWorkbenchRecipe,
  startLocalHarborRun,
  startWorkbenchSetup,
  submitRun,
  type WorkbenchFile,
  type WorkbenchPreview,
  type WorkbenchRecipe,
  type WorkbenchSetup,
} from "./api";
import { useControlState } from "./control-state";
import { PageHeader } from "./layout";
import { cn, formatDate, formatMoney } from "./lib";
import { useProfiles } from "./queries";
import { SavedConfigurations } from "./saved-configurations";
import { Badge, Button, Card, ErrorNotice } from "./ui";
import { loadWorkbenchDraft, saveWorkbenchDraft } from "./workbench-draft";

const sources = [
  "literal",
  "instruction_path",
  "workspace_path",
  "logs_path",
  "agent_home",
  "model_name",
] as const;

const hostedPendingStorageKey = "harbor-hf.workbench.pending-hosted-run.v1";

interface PendingHostedRun {
  confirmationKey: string;
  idempotencyKey: string;
}

function storedPendingHostedRun(): PendingHostedRun | null {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(hostedPendingStorageKey) ?? "null",
    ) as Partial<PendingHostedRun> | null;
    if (
      value &&
      typeof value.confirmationKey === "string" &&
      typeof value.idempotencyKey === "string"
    )
      return {
        confirmationKey: value.confirmationKey,
        idempotencyKey: value.idempotencyKey,
      };
  } catch {
    return null;
  }
  return null;
}

function storePendingHostedRun(value: PendingHostedRun | null): void {
  try {
    if (value)
      window.localStorage.setItem(hostedPendingStorageKey, JSON.stringify(value));
    else window.localStorage.removeItem(hostedPendingStorageKey);
  } catch {
    // Private browsing policies may disable storage; the in-memory key still works.
  }
}

function isManagedInferenceBinding(
  binding: WorkbenchRecipe["environment"][number],
): boolean {
  return binding.source === "model_base_url" || binding.source === "model_api_key";
}

const fastAgentStarter: WorkbenchRecipe = {
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

const fxStarter: WorkbenchRecipe = {
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
      "Edit commands and bindings, then review the authoritative recipe preview.",
    ],
    [
      "Test",
      "Install this exact recipe in a disposable CPU sandbox. No benchmark or model request is made.",
    ],
    [
      "Run",
      "Choose a reviewed hosted configuration or run a canary directly with local Harbor.",
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
        The model route, direct inference URL, and credential binding come from the
        selected hosted deployment or local deployment profile. They are not recipe
        settings.
      </p>
    </Card>
  );
}

export function WorkbenchPage() {
  const navigate = useNavigate();
  const profiles = useProfiles();
  const { writesAllowed, writeMode } = useControlState();
  const [draft] = useState(loadWorkbenchDraft);
  const [recipe, setRecipe] = useState<WorkbenchRecipe>(
    () => draft?.recipe ?? copyStarter(),
  );
  const [draftSaved, setDraftSaved] = useState(true);
  const supportsDirectLocalRun = recipe.environment.some(
    (binding) => binding.source === "model_base_url",
  );
  const [preview, setPreview] = useState<WorkbenchPreview | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);
  const [setup, setSetup] = useState<WorkbenchSetup | null>(null);
  const [setupError, setSetupError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [logs, setLogs] = useState({ stdout: "", stderr: "" });
  const [selectedFile, setSelectedFile] = useState<WorkbenchFile | null>(null);
  const [fileContent, setFileContent] = useState<{
    content: string;
    truncated: boolean;
  } | null>(null);
  const [fileError, setFileError] = useState<unknown>(null);
  const [localOptions, setLocalOptions] = useState<LocalHarborOptions | null>(null);
  const [localOptionsError, setLocalOptionsError] = useState<unknown>(null);
  const [selectedTasks, setSelectedTasks] = useState<string[]>([]);
  const [localConfig, setLocalConfig] = useState<Record<string, unknown> | null>(null);
  const [localConfigError, setLocalConfigError] = useState<unknown>(null);
  const [localRun, setLocalRun] = useState<LocalHarborRun | null>(null);
  const [localLogs, setLocalLogs] = useState({ stdout: "", stderr: "" });
  const [localRunError, setLocalRunError] = useState<unknown>(null);
  const [localConfirmation, setLocalConfirmation] = useState<string | null>(null);
  const [startingLocal, setStartingLocal] = useState(false);
  const [cancellingLocal, setCancellingLocal] = useState(false);
  const [benchmarkConfigs, setBenchmarkConfigs] = useState<BenchmarkConfig[]>([]);
  const [benchmarkConfigsError, setBenchmarkConfigsError] = useState<unknown>(null);
  const [selectedBenchmarkConfig, setSelectedBenchmarkConfig] = useState(
    draft?.selectedBenchmarkConfig ?? "",
  );
  const [hostedCeiling, setHostedCeiling] = useState(draft?.hostedCeiling ?? 0);
  const [hostedConfirmation, setHostedConfirmation] = useState<string | null>(null);
  const [hostedRunError, setHostedRunError] = useState<unknown>(null);
  const [startingHosted, setStartingHosted] = useState(false);
  const previewSequence = useRef(0);
  const hostedRequestRef = useRef<PendingHostedRun | null>(null);
  const activeSetupRef = useRef<HTMLDivElement | null>(null);
  const liveOutputRef = useRef<HTMLElement | null>(null);
  const liveOutput = `${logs.stdout}${logs.stderr ? `\n[stderr]\n${logs.stderr}` : ""}`;

  useEffect(() => {
    setDraftSaved(
      saveWorkbenchDraft({ recipe, selectedBenchmarkConfig, hostedCeiling }),
    );
  }, [recipe, selectedBenchmarkConfig, hostedCeiling]);

  useEffect(() => {
    void listWorkbenchSetups()
      .then((setups) => {
        if (setups[0]) setSetup(setups[0]);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void Promise.all([getLocalHarborOptions(), listLocalHarborRuns()])
      .then(([options, runs]) => {
        setLocalOptions(options);
        setSelectedTasks((current) =>
          current.length > 0 ? current : options.task_names.slice(0, 1),
        );
        if (runs[0]) setLocalRun(runs[0]);
      })
      .catch(setLocalOptionsError);
  }, []);

  useEffect(() => {
    void getBenchmarkConfigs()
      .then(({ items }) => {
        setBenchmarkConfigs(items);
        const first = items.length === 1 ? items[0] : undefined;
        if (!first) return;
        setSelectedBenchmarkConfig((current) => current || first.name);
        if (!draft) setHostedCeiling(first.default_ceiling_microusd);
      })
      .catch(setBenchmarkConfigsError);
  }, [draft]);

  useEffect(() => {
    const sequence = ++previewSequence.current;
    setChecking(true);
    setPreview(null);
    setPreviewError(null);
    const timer = window.setTimeout(() => {
      void previewWorkbenchRecipe(recipe)
        .then((value) => {
          if (sequence !== previewSequence.current) return;
          setPreview(value);
        })
        .catch((error: unknown) => {
          if (sequence !== previewSequence.current) return;
          setPreview(null);
          setPreviewError(error);
        })
        .finally(() => {
          if (sequence === previewSequence.current) setChecking(false);
        });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [recipe]);

  useEffect(() => {
    if (!setup || !["queued", "running", "cancelling"].includes(setup.status)) return;
    const timer = window.setInterval(() => {
      void getWorkbenchSetup(setup.setup_test_id).then(setSetup).catch(setSetupError);
      void getWorkbenchLogs(setup.setup_test_id).then(setLogs).catch(setSetupError);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [setup]);

  useEffect(() => {
    if (!preview || !supportsDirectLocalRun || selectedTasks.length === 0) {
      setLocalConfig(null);
      setLocalConfigError(null);
      return;
    }
    let current = true;
    setLocalConfigError(null);
    void previewLocalHarborConfig(recipe, selectedTasks)
      .then((config) => {
        if (current) setLocalConfig(config);
      })
      .catch((error: unknown) => {
        if (!current) return;
        setLocalConfig(null);
        setLocalConfigError(error);
      });
    return () => {
      current = false;
    };
  }, [preview, recipe, selectedTasks, supportsDirectLocalRun]);

  useEffect(() => {
    if (!localRun || !["queued", "running", "cancelling"].includes(localRun.status))
      return;
    const timer = window.setInterval(() => {
      void getLocalHarborRun(localRun.local_run_id)
        .then(setLocalRun)
        .catch(setLocalRunError);
      void getLocalHarborLogs(localRun.local_run_id)
        .then(setLocalLogs)
        .catch(setLocalRunError);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [localRun]);

  useEffect(() => {
    if (!localRun) return;
    void getLocalHarborLogs(localRun.local_run_id)
      .then(setLocalLogs)
      .catch(setLocalRunError);
  }, [localRun]);

  useEffect(() => {
    if (!setup) return;
    void getWorkbenchLogs(setup.setup_test_id).then(setLogs).catch(setSetupError);
  }, [setup]);

  useEffect(() => {
    if (!liveOutput) return;
    const output = liveOutputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [liveOutput]);

  const setupActive =
    setup !== null && ["queued", "running", "cancelling"].includes(setup.status);
  const setupMatchesCurrent =
    !checking &&
    setup !== null &&
    preview !== null &&
    preview?.recipe_digest === setup.recipe_digest &&
    preview?.revision_id === setup.revision_id;
  const verifiedCurrent = setupMatchesCurrent && setup?.status === "passed";
  const localConfirmationKey = preview
    ? [preview.recipe_digest, ...selectedTasks].join(":")
    : null;
  const selectedConfig = benchmarkConfigs.find(
    (config) => config.name === selectedBenchmarkConfig,
  );
  const resolvedDeployment = profiles.data?.items.find(
    (profile) =>
      profile.profile_kind === "deployment" &&
      (profile.alias === selectedConfig?.deployment ||
        profile.approved_aliases.includes(selectedConfig?.deployment ?? "")),
  );
  const hostedConfirmationKey =
    preview && setup && selectedConfig
      ? [
          preview.recipe_digest,
          setup.setup_test_id,
          selectedConfig.revision,
          hostedCeiling,
        ].join(":")
      : null;
  const updateEnvironment = (
    index: number,
    change: Partial<WorkbenchRecipe["environment"][number]>,
  ) => {
    setRecipe((current) => {
      const environment = [...current.environment];
      const previous = environment[index];
      if (!previous) return current;
      const next = { ...previous, ...change };
      if (next.source !== "literal") delete next.value;
      else if (next.value === undefined) next.value = "";
      environment[index] = next;
      return { ...current, environment };
    });
    setConfirmed(false);
  };

  const launchSetup = async () => {
    setSetupError(null);
    try {
      const value = await startWorkbenchSetup(recipe);
      setSetup(value);
      setConfirmed(false);
      setSelectedFile(null);
      setFileContent(null);
      setLogs({ stdout: "", stderr: "" });
      window.requestAnimationFrame(() => {
        const target = activeSetupRef.current;
        if (typeof target?.scrollIntoView === "function")
          target.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    } catch (error) {
      setSetupError(error);
    }
  };

  const cancelSetup = async () => {
    if (!setup || !setupActive) return;
    if (
      !window.confirm(
        "Cancel this setup test? The disposable setup environment will be stopped.",
      )
    )
      return;
    setCancelling(true);
    setSetupError(null);
    try {
      setSetup(await cancelWorkbenchSetup(setup.setup_test_id));
    } catch (error) {
      setSetupError(error);
    } finally {
      setCancelling(false);
    }
  };

  const selectFile = async (file: WorkbenchFile) => {
    if (!setup) return;
    setSelectedFile(file);
    setFileContent(null);
    setFileError(null);
    if (!file.text) return;
    try {
      setFileContent(await getWorkbenchFile(setup.setup_test_id, file.file_id));
    } catch (error) {
      setFileError(error);
    }
  };

  const launchLocal = async () => {
    setStartingLocal(true);
    setLocalRunError(null);
    try {
      const value = await startLocalHarborRun(recipe, selectedTasks);
      setLocalRun(value);
      setLocalLogs({ stdout: "", stderr: "" });
      setLocalConfirmation(null);
    } catch (error) {
      setLocalRunError(error);
    } finally {
      setStartingLocal(false);
    }
  };

  const launchHosted = async () => {
    if (!setup || !selectedConfig || !verifiedCurrent || !hostedConfirmationKey) return;
    setStartingHosted(true);
    setHostedRunError(null);
    try {
      if (hostedRequestRef.current?.confirmationKey !== hostedConfirmationKey) {
        const stored = storedPendingHostedRun();
        hostedRequestRef.current =
          stored?.confirmationKey === hostedConfirmationKey
            ? stored
            : {
                confirmationKey: hostedConfirmationKey,
                idempotencyKey: crypto.randomUUID(),
              };
        storePendingHostedRun(hostedRequestRef.current);
      }
      const value = await submitRun(
        {
          benchmark_config: selectedConfig.name,
          benchmark_config_revision: selectedConfig.revision,
          harness: {
            type: "workbench",
            recipe: { ...recipe },
            setup_test_id: setup.setup_test_id,
          },
          ceiling_microusd: hostedCeiling,
          confirmed: true,
        },
        hostedRequestRef.current.idempotencyKey,
      );
      storePendingHostedRun(null);
      hostedRequestRef.current = null;
      navigate(value.status_url.replace(/^\/api\/v1/, ""));
    } catch (error) {
      setHostedRunError(error);
    } finally {
      setStartingHosted(false);
    }
  };

  const cancelLocal = async () => {
    if (!localRun || !["queued", "running"].includes(localRun.status)) return;
    if (!window.confirm("Cancel this local Harbor process and its active trials?"))
      return;
    setCancellingLocal(true);
    setLocalRunError(null);
    try {
      setLocalRun(await cancelLocalHarborRun(localRun.local_run_id));
    } catch (error) {
      setLocalRunError(error);
    } finally {
      setCancellingLocal(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Agent Workbench"
        description="Configure a command-line harness, verify its setup, then combine that exact recipe with a reviewed hosted Run configuration."
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setRecipe(copyStarter());
                setSetup(null);
                setConfirmed(false);
                setLocalConfirmation(null);
              }}
            >
              <RotateCcw size={16} /> Fast-Agent 0.10.16
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setRecipe(copyStarter(fxStarter));
                setSetup(null);
                setConfirmed(false);
                setLocalConfirmation(null);
              }}
            >
              <RotateCcw size={16} /> FX 0.0.6
            </Button>
          </div>
        }
      />

      <SavedConfigurations
        canSave={writesAllowed}
        recipe={recipe}
        onLoad={(saved) => {
          setRecipe(saved);
          setSetup(null);
          setConfirmed(false);
          setLocalConfirmation(null);
          setHostedConfirmation(null);
        }}
      />
      <WorkbenchFlow />
      <p className="mb-4 text-sm text-slate-400" role="status">
        {draftSaved
          ? "Draft saved in this browser. Never include secrets. Confirm again after reloading."
          : "Draft could not be saved in this browser. Copy your edits before reloading."}
      </p>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)]">
        <div className="min-w-0 space-y-6">
          <Card>
            <div className="mb-5 flex items-center gap-3">
              <TerminalSquare className="text-cyan-300" size={20} />
              <div>
                <h2 className="font-semibold text-white">Commands</h2>
                <p className="text-sm text-slate-400">
                  Describe how to install and invoke the harness.
                </p>
              </div>
            </div>
            <div className="space-y-5">
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-slate-200">
                  Configuration name
                </span>
                <input
                  className={fieldClass()}
                  value={recipe.name}
                  onChange={(event) =>
                    setRecipe((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-slate-200">
                  Setup command
                </span>
                <textarea
                  aria-label="Setup command"
                  className={cn(fieldClass(), "min-h-40 font-mono leading-6")}
                  spellCheck={false}
                  value={recipe.setup_command}
                  onChange={(event) =>
                    setRecipe((current) => ({
                      ...current,
                      setup_command: event.target.value,
                    }))
                  }
                />
                <span className="mt-1 block text-xs text-slate-500">
                  Runs without model credentials in a disposable setup environment.
                </span>
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-slate-200">
                  Run command
                </span>
                <textarea
                  aria-label="Run command"
                  className={cn(fieldClass(), "min-h-56 font-mono leading-6")}
                  spellCheck={false}
                  value={recipe.run_command}
                  onChange={(event) =>
                    setRecipe((current) => ({
                      ...current,
                      run_command: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="block max-w-xs">
                <span className="mb-2 block text-sm font-medium text-slate-200">
                  Setup timeout
                </span>
                <div className="flex items-center gap-2">
                  <input
                    className={fieldClass()}
                    min={30}
                    max={3600}
                    type="number"
                    value={recipe.setup_timeout_seconds}
                    onChange={(event) =>
                      setRecipe((current) => ({
                        ...current,
                        setup_timeout_seconds: Number(event.target.value),
                      }))
                    }
                  />
                  <span className="text-sm text-slate-500">seconds</span>
                </div>
              </label>
            </div>
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          <Card>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-white">Authoritative preview</h2>
                <p className="mt-1 text-sm text-slate-400">
                  Generated by the same compiler that locks the recipe.
                </p>
              </div>
              {checking ? (
                <LoaderCircle className="animate-spin text-cyan-300" size={18} />
              ) : preview ? (
                <Badge status="complete">Preview ready</Badge>
              ) : (
                <Badge status="error">Invalid</Badge>
              )}
            </div>
            {previewError ? <ErrorNotice error={previewError} /> : null}
            {preview ? (
              <div className="space-y-4">
                <div className="rounded-lg bg-slate-900 p-3 text-xs text-slate-400">
                  <div>
                    Revision:{" "}
                    <code className="break-all text-slate-200">
                      {preview.revision_id}
                    </code>
                  </div>
                  <div className="mt-1 break-all">
                    Digest:{" "}
                    <code className="text-slate-200">{preview.recipe_digest}</code>
                  </div>
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-medium text-slate-200">
                    Expanded setup
                  </h3>
                  <pre className="max-h-64 overflow-auto rounded-lg border border-slate-800 bg-black/30 p-3 text-xs leading-5 text-slate-300">
                    {preview.setup_command}
                  </pre>
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-medium text-slate-200">
                    Expanded run command
                  </h3>
                  <pre className="max-h-80 overflow-auto rounded-lg border border-slate-800 bg-black/30 p-3 text-xs leading-5 text-slate-300">
                    {preview.run_command}
                  </pre>
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-medium text-slate-200">
                    Effective environment
                  </h3>
                  <div className="space-y-1 rounded-lg border border-slate-800 p-3 font-mono text-xs">
                    {preview.environment
                      .filter(
                        (item) =>
                          item.source !== "model_base_url" &&
                          item.source !== "model_api_key",
                      )
                      .map((item) => (
                        <div className="break-all" key={item.name}>
                          <span className="text-cyan-300">{item.name}</span>
                          <span className="text-slate-600">=</span>
                          <span className="text-slate-300">{item.value}</span>
                        </div>
                      ))}
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    Model connectivity is injected by the deployment and is
                    intentionally omitted here.
                  </p>
                </div>
              </div>
            ) : null}
          </Card>

          <Card>
            <div className="mb-4 flex items-center gap-3">
              <FlaskConical className="text-cyan-300" size={20} />
              <div>
                <h2 className="font-semibold text-white">Try setup</h2>
                <p className="text-sm text-slate-400">
                  Installs the agent without running a benchmark or model request.
                </p>
              </div>
            </div>
            {setupError ? <ErrorNotice error={setupError} /> : null}
            {setup && !setupMatchesCurrent && setup.status === "passed" ? (
              <p className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
                This setup passed for an older recipe. Test the current edits before
                starting Harbor.
              </p>
            ) : null}
            {setupActive ? (
              <div
                className="space-y-4 rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-4"
                ref={activeSetupRef}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <LoaderCircle className="animate-spin text-cyan-300" size={18} />
                    <span className="font-medium text-white">Setup submitted</span>
                    <Badge status="active">{setup.status}</Badge>
                  </div>
                  <Button
                    disabled={cancelling || setup.status === "cancelling"}
                    variant="secondary"
                    onClick={() => void cancelSetup()}
                  >
                    <Square size={14} />
                    {setup.status === "cancelling" || cancelling
                      ? "Cancelling…"
                      : "Cancel setup"}
                  </Button>
                </div>
                <p className="text-xs text-slate-400">
                  Confirmation was reset for any future retry. This setup continues
                  below and can be safely cancelled here.
                </p>
                <section
                  aria-label="Live setup output"
                  className="max-h-64 min-h-32 overflow-auto rounded-lg border border-slate-800 bg-black/40 p-3 text-xs leading-5 text-slate-300"
                  ref={liveOutputRef}
                >
                  <pre className="whitespace-pre-wrap break-words">
                    {liveOutput || "Waiting for setup output…"}
                  </pre>
                </section>
              </div>
            ) : (
              <>
                <label className="flex items-start gap-3 text-sm text-slate-300">
                  <input
                    className="mt-1"
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  <span>
                    Launch this exact setup recipe in a disposable CPU sandbox.
                  </span>
                </label>
                <Button
                  className="mt-4 w-full"
                  disabled={!confirmed || !preview || checking}
                  onClick={() => void launchSetup()}
                >
                  <FlaskConical size={16} /> Launch setup test
                </Button>
              </>
            )}
          </Card>
        </div>

        <Card className="xl:col-span-2">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-semibold text-white">Environment</h2>
              <p className="mt-1 text-sm text-slate-400">
                Configure task paths and ordinary non-secret values. Model connectivity
                is managed by the deployment.
              </p>
            </div>
            <Button
              variant="secondary"
              onClick={() =>
                setRecipe((current) => ({
                  ...current,
                  environment: [
                    ...current.environment,
                    { name: "NEW_VALUE", source: "literal", value: "" },
                  ],
                }))
              }
            >
              <Plus size={15} /> Add
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {recipe.environment.map((binding, index) =>
              isManagedInferenceBinding(binding) ? null : (
                <div
                  className="relative grid gap-3 rounded-lg border border-slate-800 p-3 pr-12 sm:grid-cols-2"
                  // biome-ignore lint/suspicious/noArrayIndexKey: the portable recipe contract intentionally has no UI-only row identifier.
                  key={`${index}-${binding.name}`}
                >
                  <label>
                    <span className="mb-1 block text-xs text-slate-500">Name</span>
                    <input
                      aria-label={`Environment variable ${index + 1} name`}
                      className={fieldClass()}
                      value={binding.name}
                      onChange={(event) =>
                        updateEnvironment(index, { name: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span className="mb-1 block text-xs text-slate-500">Source</span>
                    <select
                      aria-label={`Environment variable ${binding.name} source`}
                      className={fieldClass()}
                      value={binding.source}
                      onChange={(event) =>
                        updateEnvironment(index, {
                          source: event.target
                            .value as WorkbenchRecipe["environment"][number]["source"],
                        })
                      }
                    >
                      {sources.map((source) => (
                        <option key={source} value={source}>
                          {source.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="sm:col-span-2">
                    <span className="mb-1 block text-xs text-slate-500">
                      {binding.source === "literal" ? "Value" : "Effective binding"}
                    </span>
                    <input
                      aria-label={`Environment variable ${binding.name} value`}
                      className={fieldClass()}
                      disabled={binding.source !== "literal"}
                      value={
                        binding.source === "literal"
                          ? (binding.value ?? "")
                          : `<${binding.source.replaceAll("_", " ")}>`
                      }
                      onChange={(event) =>
                        updateEnvironment(index, { value: event.target.value })
                      }
                    />
                  </label>
                  <Button
                    aria-label={`Remove ${binding.name}`}
                    className="absolute right-2 top-2"
                    variant="ghost"
                    onClick={() =>
                      setRecipe((current) => ({
                        ...current,
                        environment: current.environment.filter(
                          (_item, itemIndex) => itemIndex !== index,
                        ),
                      }))
                    }
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              ),
            )}
          </div>
        </Card>

        <Card className="xl:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <PlayCircle className="text-cyan-300" size={20} />
                <h2 className="font-semibold text-white">Run hosted</h2>
                <Badge status={verifiedCurrent ? "complete" : "active"}>
                  {verifiedCurrent ? "Installation passed" : "Awaiting install test"}
                </Badge>
              </div>
              <p className="mt-2 max-w-3xl text-sm text-slate-400">
                Select a reviewed benchmark configuration. Harbor-HF locks its
                benchmark, model, deployment, worker, hardware, retry policy, and
                evidence envelope together with this exact tested recipe.
              </p>
            </div>
          </div>
          {!writesAllowed ? (
            <p className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
              Hosted launch is unavailable because write mode is {writeMode}.
            </p>
          ) : null}
          {benchmarkConfigsError ? (
            <div className="mt-4">
              <ErrorNotice error={benchmarkConfigsError} />
            </div>
          ) : null}
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="text-sm text-slate-300">
              <span className="mb-1.5 block text-slate-400">
                Benchmark configuration
              </span>
              <select
                aria-label="Benchmark configuration"
                className={fieldClass()}
                disabled={!writesAllowed || benchmarkConfigs.length === 0}
                value={selectedBenchmarkConfig}
                onChange={(event) => {
                  const next = benchmarkConfigs.find(
                    (config) => config.name === event.target.value,
                  );
                  setSelectedBenchmarkConfig(event.target.value);
                  if (next) setHostedCeiling(next.default_ceiling_microusd);
                  setHostedConfirmation(null);
                }}
              >
                <option value="">Select a reviewed configuration…</option>
                {benchmarkConfigs.map((config) => (
                  <option key={config.name} value={config.name}>
                    {config.label} · {config.size}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-slate-300">
              <span className="mb-1.5 block text-slate-400">Cost ceiling, USD</span>
              <input
                aria-label="Hosted cost ceiling, USD"
                className={fieldClass()}
                disabled={!writesAllowed || !selectedConfig}
                type="number"
                min="0"
                max={
                  selectedConfig
                    ? selectedConfig.max_ceiling_microusd / 1_000_000
                    : undefined
                }
                step="0.01"
                value={hostedCeiling / 1_000_000}
                onChange={(event) => {
                  setHostedCeiling(
                    Math.max(0, Math.round(Number(event.target.value) * 1_000_000)),
                  );
                  setHostedConfirmation(null);
                }}
              />
            </label>
          </div>
          {selectedConfig ? (
            <>
              <p className="mt-4 text-sm text-slate-400">
                {selectedConfig.description} Size: {selectedConfig.size}. Size is
                workload guidance, not a price guarantee; model and infrastructure
                charges vary. Results are saved automatically.
              </p>
              <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt className="text-slate-500">Benchmark</dt>
                  <dd className="mt-1 font-mono text-slate-300">
                    {selectedConfig.benchmark}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Model</dt>
                  <dd className="mt-1 font-mono text-slate-300">
                    {selectedConfig.model}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Tasks</dt>
                  <dd className="mt-1 text-slate-300">{selectedConfig.task_count}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Maximum ceiling</dt>
                  <dd className="mt-1 text-slate-300">
                    {formatMoney(selectedConfig.max_ceiling_microusd)}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Resolved inference provider</dt>
                  <dd className="mt-1 font-mono text-slate-300">
                    {String(
                      resolvedDeployment?.spec.inference_provider ??
                        "Not reported in loaded profiles",
                    )}
                  </dd>
                  <dt className="text-slate-500">Locked deployment</dt>
                  <dd className="mt-1 font-mono text-slate-300">
                    {selectedConfig.deployment}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Launch policy</dt>
                  <dd className="mt-1 font-mono text-slate-300">
                    {selectedConfig.launch_policy}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Result role</dt>
                  <dd className="mt-1 text-slate-300">
                    {selectedConfig.publication_role}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Recipe revision</dt>
                  <dd className="mt-1 break-all font-mono text-slate-300">
                    {preview?.revision_id ?? "Waiting for preview"}
                  </dd>
                </div>
              </dl>
            </>
          ) : null}
          <div className="mt-5 border-t border-slate-800 pt-5">
            <label className="flex items-start gap-3 text-sm text-slate-300">
              <input
                className="mt-1 accent-cyan-400"
                type="checkbox"
                disabled={!writesAllowed || !verifiedCurrent || !selectedConfig}
                checked={
                  hostedConfirmationKey !== null &&
                  hostedConfirmation === hostedConfirmationKey
                }
                onChange={(event) =>
                  setHostedConfirmation(
                    event.target.checked ? hostedConfirmationKey : null,
                  )
                }
              />
              <span>
                I confirm this exact tested recipe, reviewed benchmark configuration,
                and {formatMoney(hostedCeiling)} hard cost ceiling.
              </span>
            </label>
            {hostedRunError ? (
              <div className="mt-4">
                <ErrorNotice error={hostedRunError} />
              </div>
            ) : null}
            <Button
              className="mt-4"
              disabled={
                !writesAllowed ||
                !verifiedCurrent ||
                !selectedConfig ||
                hostedCeiling <= 0 ||
                hostedCeiling > selectedConfig.max_ceiling_microusd ||
                hostedConfirmationKey === null ||
                hostedConfirmation !== hostedConfirmationKey ||
                startingHosted
              }
              onClick={() => void launchHosted()}
            >
              <PlayCircle size={16} />
              {startingHosted ? "Starting hosted run…" : "Start hosted run"}
            </Button>
            {!verifiedCurrent ? (
              <p className="mt-2 text-xs text-slate-500">
                Pass setup for the current recipe before starting a hosted Run.
              </p>
            ) : null}
          </div>
        </Card>

        {localOptions?.enabled !== false ? (
          <Card className="xl:col-span-2">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <PlayCircle className="text-cyan-300" size={20} />
                  <h2 className="font-semibold text-white">Run locally with Harbor</h2>
                  {localOptions ? (
                    <Badge status={localOptions.ready ? "complete" : "error"}>
                      {localOptions.ready
                        ? "Local prerequisites available"
                        : "Unavailable"}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-2 max-w-3xl text-sm text-slate-400">
                  Uses the checked-in Terminal-Bench 2.1 canary and approved model
                  route. Harbor owns task resolution, the container environment,
                  verification, and native results.
                </p>
              </div>
              {localOptions?.harbor_version ? (
                <div className="text-right text-xs text-slate-500">
                  <div>Installed: {localOptions.harbor_version}</div>
                  {localOptions.expected_harbor_version ? (
                    <div>Profile: Harbor {localOptions.expected_harbor_version}</div>
                  ) : null}
                </div>
              ) : null}
            </div>
            {localOptionsError ? (
              <div className="mt-4">
                <ErrorNotice error={localOptionsError} />
              </div>
            ) : null}
            {localOptions?.reason ? (
              <p className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
                {localOptions.reason}
              </p>
            ) : null}
            {!supportsDirectLocalRun ? (
              <p className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
                This recipe can be setup-tested, but it cannot use the direct local
                inference route. FX 0.0.6 expects Vercel AI Gateway semantics, so Harbor
                Run remains disabled to keep the HF inference credential on its intended
                endpoint.
              </p>
            ) : null}
            <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(16rem,0.65fr)_minmax(0,1.35fr)]">
              <div>
                <h3 className="text-sm font-medium text-slate-200">Canary tasks</h3>
                <div className="mt-3 space-y-2">
                  {(localOptions?.task_names ?? []).map((taskName) => (
                    <label
                      className="flex items-start gap-3 rounded-lg border border-slate-800 p-3 text-sm text-slate-300"
                      key={taskName}
                    >
                      <input
                        className="mt-0.5 accent-cyan-400"
                        type="checkbox"
                        checked={selectedTasks.includes(taskName)}
                        onChange={(event) => {
                          setSelectedTasks((current) =>
                            event.target.checked
                              ? [...current, taskName]
                              : current.filter((item) => item !== taskName),
                          );
                          setLocalConfirmation(null);
                        }}
                      />
                      <span className="font-mono text-xs">{taskName}</span>
                    </label>
                  ))}
                </div>
                <dl className="mt-4 space-y-2 text-xs">
                  <div>
                    <dt className="text-slate-500">Benchmark</dt>
                    <dd className="font-mono text-slate-300">
                      {localOptions?.benchmark ?? "Loading…"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Model</dt>
                    <dd className="font-mono text-slate-300">
                      {localOptions?.model ?? "Loading…"}
                    </dd>
                  </div>
                </dl>
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-slate-200">
                  Generated Harbor config
                </h3>
                {localConfigError ? (
                  <div className="mt-3">
                    <ErrorNotice error={localConfigError} />
                  </div>
                ) : (
                  <pre className="mt-3 max-h-96 overflow-auto rounded-lg border border-slate-800 bg-black/30 p-3 text-xs leading-5 text-slate-300">
                    {localConfig
                      ? JSON.stringify(localConfig, null, 2)
                      : "Select a task and wait for a valid recipe preview."}
                  </pre>
                )}
              </div>
            </div>
            <div className="mt-5 border-t border-slate-800 pt-5">
              <label className="flex items-start gap-3 text-sm text-slate-300">
                <input
                  className="mt-1 accent-cyan-400"
                  type="checkbox"
                  checked={
                    localConfirmationKey !== null &&
                    localConfirmation === localConfirmationKey
                  }
                  onChange={(event) =>
                    setLocalConfirmation(
                      event.target.checked ? localConfirmationKey : null,
                    )
                  }
                />
                <span>
                  Start Harbor locally with this exact recipe, config, and task
                  selection.
                </span>
              </label>
              {localRunError ? (
                <div className="mt-4">
                  <ErrorNotice error={localRunError} />
                </div>
              ) : null}
              <Button
                className="mt-4"
                disabled={
                  !localOptions?.ready ||
                  !supportsDirectLocalRun ||
                  !verifiedCurrent ||
                  !localConfig ||
                  selectedTasks.length === 0 ||
                  localConfirmationKey === null ||
                  localConfirmation !== localConfirmationKey ||
                  startingLocal ||
                  Boolean(
                    localRun &&
                      ["queued", "running", "cancelling"].includes(localRun.status),
                  )
                }
                onClick={() => void launchLocal()}
              >
                <PlayCircle size={16} />
                {startingLocal ? "Starting Harbor…" : "Start local benchmark"}
              </Button>
              {!verifiedCurrent ? (
                <p className="mt-2 text-xs text-slate-500">
                  Pass setup for the current recipe before starting the benchmark.
                </p>
              ) : null}
            </div>
          </Card>
        ) : null}
      </div>

      {localRun ? (
        <Card className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                {["queued", "running", "cancelling"].includes(localRun.status) ? (
                  <LoaderCircle className="animate-spin text-cyan-300" size={20} />
                ) : localRun.status === "succeeded" ? (
                  <CheckCircle2 className="text-emerald-400" size={20} />
                ) : (
                  <FlaskConical className="text-rose-400" size={20} />
                )}
                <h2 className="font-semibold text-white">Local Harbor run</h2>
                <Badge
                  status={
                    localRun.status === "succeeded"
                      ? "complete"
                      : ["failed", "cancelled"].includes(localRun.status)
                        ? "error"
                        : "active"
                  }
                >
                  {localRun.status}
                </Badge>
              </div>
              <p className="mt-2 break-all font-mono text-xs text-slate-500">
                {localRun.config_path}
              </p>
              {localRun.result_path ? (
                <p className="mt-1 break-all font-mono text-xs text-emerald-300">
                  Result: {localRun.result_path}
                </p>
              ) : null}
            </div>
            {["queued", "running", "cancelling"].includes(localRun.status) ? (
              <Button
                variant="secondary"
                disabled={cancellingLocal || localRun.status === "cancelling"}
                onClick={() => void cancelLocal()}
              >
                <Square size={14} />
                {cancellingLocal || localRun.status === "cancelling"
                  ? "Cancelling…"
                  : "Cancel run"}
              </Button>
            ) : null}
          </div>
          {localRun.error ? (
            <p className="mt-4 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
              {localRun.error}
            </p>
          ) : null}
          <section
            aria-label="Local Harbor output"
            className="mt-4 max-h-[36rem] min-h-48 overflow-auto rounded-lg border border-slate-800 bg-black/40 p-3 text-xs leading-5 text-slate-300"
          >
            <pre className="whitespace-pre-wrap break-words">
              {localLogs.stdout}
              {localLogs.stderr ? `\n[stderr]\n${localLogs.stderr}` : ""}
              {!localLogs.stdout && !localLogs.stderr
                ? "Waiting for Harbor output…"
                : ""}
            </pre>
          </section>
        </Card>
      ) : null}

      {setup ? (
        <div className="mt-6 space-y-6">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  {setup.status === "passed" ? (
                    <CheckCircle2 className="text-emerald-400" size={20} />
                  ) : ["running", "queued", "cancelling"].includes(setup.status) ? (
                    <LoaderCircle className="animate-spin text-cyan-300" size={20} />
                  ) : (
                    <FlaskConical className="text-rose-400" size={20} />
                  )}
                  <h2 className="font-semibold text-white">Setup test</h2>
                  <Badge status={statusTone(setup.status)}>{setup.status}</Badge>
                </div>
                <p className="mt-2 text-sm text-slate-400">
                  Started {setup.started_at ? formatDate(setup.started_at) : "soon"}
                  {setup.completed_at
                    ? ` · finished ${formatDate(setup.completed_at)}`
                    : ""}
                </p>
                {verifiedCurrent ? (
                  <p className="mt-2 max-w-xl text-sm text-slate-300">
                    Installation passed for the current recipe. This does not verify
                    hosted preparation, model connectivity, or inference. Review launch
                    options above.
                  </p>
                ) : null}
              </div>
            </div>
            {setup.error ? (
              <p className="mt-4 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
                {setup.error}
              </p>
            ) : null}
          </Card>

          {!setupActive ? (
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <Card>
                <h2 className="font-semibold text-white">Final setup output</h2>
                <div className="mt-4 space-y-4">
                  <div>
                    <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                      Standard output
                    </h3>
                    <section
                      aria-label="Final setup standard output"
                      className="max-h-[32rem] min-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-800 bg-black/30 p-3 text-xs leading-5 text-slate-300"
                    >
                      <pre>{logs.stdout || "Waiting for output…"}</pre>
                    </section>
                  </div>
                  {logs.stderr ? (
                    <div>
                      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                        Standard error
                      </h3>
                      <section
                        aria-label="Final setup standard error"
                        className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-rose-900/60 bg-rose-950/20 p-3 text-xs leading-5 text-rose-200"
                      >
                        <pre>{logs.stderr}</pre>
                      </section>
                    </div>
                  ) : null}
                </div>
              </Card>

              <Card>
                <h2 className="font-semibold text-white">Created files</h2>
                <p className="mt-1 text-sm text-slate-400">
                  Text previews are escaped and bounded. Binary files are listed only.
                </p>
                <div className="mt-4 grid grid-cols-1 min-h-72 gap-4 md:grid-cols-[minmax(12rem,0.8fr)_minmax(0,1.2fr)]">
                  <div className="max-h-[32rem] overflow-auto rounded-lg border border-slate-800 p-2">
                    {setup.files.length === 0 ? (
                      <p className="p-3 text-sm text-slate-500">
                        Files appear after setup completes.
                      </p>
                    ) : (
                      setup.files.map((file) => (
                        <button
                          className={cn(
                            "block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400",
                            selectedFile?.file_id === file.file_id
                              ? "bg-cyan-400/10 text-cyan-200"
                              : "text-slate-300",
                          )}
                          key={file.file_id}
                          onClick={() => void selectFile(file)}
                          type="button"
                        >
                          <span className="text-slate-500">{file.root}/</span>
                          {file.path}
                          <span className="ml-2 text-slate-600">{file.size} B</span>
                        </button>
                      ))
                    )}
                  </div>
                  <div className="min-w-0 rounded-lg border border-slate-800 bg-black/20 p-3">
                    {fileError ? <ErrorNotice error={fileError} /> : null}
                    {!selectedFile ? (
                      <p className="text-sm text-slate-500">
                        Select a file to inspect it.
                      </p>
                    ) : !selectedFile.text ? (
                      <p className="text-sm text-slate-400">
                        Binary file · {selectedFile.size} bytes
                      </p>
                    ) : fileContent ? (
                      <>
                        <section
                          aria-label={`Contents of ${selectedFile.path}`}
                          className="max-h-[30rem] overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-slate-300"
                        >
                          <pre>{fileContent.content}</pre>
                        </section>
                        {fileContent.truncated ? (
                          <p className="mt-2 text-xs text-amber-300">
                            Preview truncated.
                          </p>
                        ) : null}
                      </>
                    ) : (
                      <p className="text-sm text-slate-500">Loading preview…</p>
                    )}
                  </div>
                </div>
              </Card>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
