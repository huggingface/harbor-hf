"""Offline native fragment emitted by compileAgentWorkbenchRecipe.

Generated from the existing fastAgentWorkbenchStarter in control-core/src/workbench.ts.
Only compilation was invoked: no setup, installation, agent instance or inference.
The model and native env binding are filled by the run compiler, not the recipe.
"""

WORKBENCH_AGENT = {
    "import_path": "harbor_hf_agents.command_agent.agent:CommandAgent",
    "override_setup_timeout_sec": 1800,
    "kwargs": {
        "config": {
            "schema_version": "v1",
            "setup": {
                "script": "set -eu\n"
                "uv_version=0.12.5\n"
                "uv_sha256=68a509da24b06b4223a1c0175fb5eb5bc79342b76cbeff0cfe51ac3f5b17b6b2\n"
                "python_version=3.12.14\n"
                'case "$(uname -m)" in\n'
                "  x86_64|amd64) "
                "uv_target=x86_64-unknown-linux-gnu ;;\n"
                '  *) printf "unsupported setup '
                'architecture\\n" >&2; exit 2 ;;\n'
                "esac\n"
                "command -v /usr/lib/apt/apt-helper "
                ">/dev/null 2>&1\n"
                "command -v tar >/dev/null 2>&1\n"
                "command -v sha256sum >/dev/null 2>&1\n"
                'mkdir -p "$AGENT_HOME/bin" '
                '"$AGENT_HOME/cache" "$AGENT_HOME/python"\n'
                'uv_archive="$AGENT_HOME/cache/uv-${uv_version}.tar.gz"\n'
                'uv_download_log="$AGENT_HOME/cache/uv-download.log"\n'
                "if ! /usr/lib/apt/apt-helper \\\n"
                "  -o Acquire::https::Verify-Peer=false \\\n"
                "  -o Acquire::https::Verify-Host=false \\\n"
                "  download-file \\\n"
                "  "
                '"https://github.com/astral-sh/uv/releases/download/'
                '${uv_version}/uv-${uv_target}.tar.gz" '
                "\\\n"
                '  "$uv_archive" >"$uv_download_log" 2>&1\n'
                "then\n"
                '  printf "pinned uv download failed\\n" '
                ">&2\n"
                "  exit 1\n"
                "fi\n"
                'printf "%s  %s\\n" "$uv_sha256" '
                '"$uv_archive" |\n'
                "  sha256sum --check --strict\n"
                'rm -rf "$AGENT_HOME/cache/uv-extract"\n'
                'mkdir -p "$AGENT_HOME/cache/uv-extract"\n'
                'tar -xzf "$uv_archive" \\\n'
                '  -C "$AGENT_HOME/cache/uv-extract" \\\n'
                "  --strip-components=1\n"
                "install -m 0755 "
                '"$AGENT_HOME/cache/uv-extract/uv" '
                '"$AGENT_HOME/bin/uv"\n'
                'UV_CACHE_DIR="$AGENT_HOME/cache/uv" \\\n'
                'UV_PYTHON_INSTALL_DIR="$AGENT_HOME/python" '
                "\\\n"
                "UV_NO_PROGRESS=1 \\\n"
                '  "$AGENT_HOME/bin/uv" python install '
                '"$python_version"\n'
                'UV_CACHE_DIR="$AGENT_HOME/cache/uv" \\\n'
                'UV_PYTHON_INSTALL_DIR="$AGENT_HOME/python" '
                "\\\n"
                "UV_NO_PROGRESS=1 \\\n"
                '  "$AGENT_HOME/bin/uv" venv \\\n'
                '  --python "$python_version" \\\n'
                "  --python-preference only-managed \\\n"
                '  "$AGENT_HOME/venv"\n'
                'UV_CACHE_DIR="$AGENT_HOME/cache/uv" \\\n'
                'UV_PYTHON_INSTALL_DIR="$AGENT_HOME/python" '
                "\\\n"
                "UV_NO_PROGRESS=1 \\\n"
                '  "$AGENT_HOME/bin/uv" pip install \\\n'
                '  --python "$AGENT_HOME/venv/bin/python" '
                "\\\n"
                "  fast-agent-mcp==0.10.24\n"
                '"$AGENT_HOME/venv/bin/python" --version\n'
                '"$AGENT_HOME/venv/bin/fast-agent" '
                "--version",
                "bindings": {
                    "AGENT_HOME": "agent_home",
                    "AGENT_MODEL": "model_name",
                    "TASK_WORKSPACE": "workspace_path",
                },
                "literals": {
                    "AGENT_RESULTS_PATH": "/logs/agent/fast-agent-results.json",
                    "AGENT_TRAJECTORY_PATH": "/logs/agent/trajectory.json",
                },
            },
            "run": {
                "script": "set -eu\n"
                "\n"
                'case "$AGENT_MODEL" in\n'
                '  hf.*/*:*) harness_model="$AGENT_MODEL" ;;\n'
                "  openai/*/*:*) "
                'harness_model="hf.${AGENT_MODEL#openai/}" '
                ";;\n"
                '  *) printf "%s\\n" "Expected a full Hub '
                'model ID and HF provider from Workbench" '
                ">&2; exit 2 ;;\n"
                "esac\n"
                "\n"
                ': "${OPENAI_API_KEY:?Injected inference key '
                'is missing or empty}"\n'
                "\n"
                'ca_bundle="$("$AGENT_HOME/venv/bin/python" '
                "-c 'import certifi; "
                "print(certifi.where())')\"\n"
                'test -r "$ca_bundle" || {\n'
                '  printf "%s\\n" "certifi CA bundle is not '
                'readable" >&2\n'
                "  exit 1\n"
                "}\n"
                "\n"
                'HF_TOKEN="$OPENAI_API_KEY" \\\n'
                'SSL_CERT_FILE="$ca_bundle" \\\n'
                '"$AGENT_HOME/venv/bin/fast-agent" go \\\n'
                '  --model "$harness_model" \\\n'
                '  --prompt-file "$TASK_INSTRUCTION_PATH" \\\n'
                '  --workspace "$TASK_WORKSPACE" \\\n'
                '  --home "$AGENT_HOME/runtime" \\\n'
                '  --results "$AGENT_RESULTS_PATH" \\\n'
                "  --trajectory-output "
                '"$AGENT_TRAJECTORY_PATH" \\\n'
                "  --shell \\\n"
                "  --quiet",
                "bindings": {
                    "AGENT_HOME": "agent_home",
                    "AGENT_MODEL": "model_name",
                    "OPENAI_API_KEY": "model_api_key",
                    "MODEL_BASE_URL": "model_base_url",
                    "TASK_INSTRUCTION_PATH": "instruction_path",
                    "TASK_WORKSPACE": "workspace_path",
                },
                "literals": {
                    "AGENT_RESULTS_PATH": "/logs/agent/fast-agent-results.json",
                    "AGENT_TRAJECTORY_PATH": "/logs/agent/trajectory.json",
                },
            },
            "route_api": "chat-completions",
            "outputs": [{"path": "fast-agent-results.json"}],
            "atif": {"path": "trajectory.json"},
        }
    },
}


def native_transport_roundtrip(tmp_path, request, response):
    """Replay real Python output through compiled TS transport + immutable storage.

    CI builds Node workspaces before setting up the agent test environment. Never
    skip this gate or require a Python environment during npm test. The real
    launch entry point reads actual TS-serialized stdin. Only external admission
    and task downloads are stubbed; evidence validation and hashing are real.
    """
    import json
    import subprocess
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parents[3]
    script = r"""
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const load = p => import(pathToFileURL(`${root}/${p}`));
const { NativeLaunch } = await load('apps/control-api/dist/launch.js');
const { loadConfig } = await load('apps/control-api/dist/config.js');
const { replacementViewSchema } =
  await load('apps/control-api/dist/replacement-schemas.js');
const { validateRunRecord } = await load('packages/contracts/dist/index.js');
const { FilesystemObjectStore, ReplacementEvidence, createJson,
  readJson, reviewFingerprint } =
  await load('packages/control-core/dist/index.js');
const { request, response, python } = JSON.parse(
  await readFile(process.argv[1], 'utf8'));
const directory = process.argv[2];
const executable = `${directory}/inspector.mjs`;
request.original = await new ReplacementEvidence(
  new FilesystemObjectStore(`${directory}/evidence`)
).bundle(request.original.record.run_id);
async function output(value) {
  await writeFile(executable, `#!${process.execPath}\nprocess.stdin.resume();
process.stdin.on('end', () =>
  console.log(${JSON.stringify(JSON.stringify(value))}));\n`,
    {mode: 0o700});
}
await writeFile(executable, `#!${python}
import sys
from unittest.mock import patch
from harbor_hf_agents import launch, replacements
async def admission(*args, **kwargs):
    return set(), []
async def plan(config, private):
    return {"harbor_revision": launch.REVISION, "tasks": len(config.tasks),
        "agents": len(config.agents), "trials": len(config.tasks) * config.n_attempts,
        "warnings": [], "not_performed": ["offline external admission and downloads"]}
sys.argv = [sys.argv[0], sys.argv[-1]]
with (patch.object(replacements, "admit", admission),
      patch.object(launch, "inspect_plan", plan)):
    launch.main()
`, {mode: 0o700});
const config = loadConfig({ NODE_ENV: 'test', HARBOR_HF_NAMESPACE: 'test',
  HARBOR_HF_BUCKET_ID: 'test/artifacts', HARBOR_HF_AUTH_MODE: 'development',
  HARBOR_HF_STORE_MODE: 'filesystem' });
const launch = new NativeLaunch({...config, launch_python: executable});
const inspected = await launch.replacementReview(request);
assert.equal(inspected.fingerprint, response.fingerprint);
assert.match(inspected.fingerprint, /^sha256:[0-9a-f]{64}$/);
const selection = {original_run_id: request.original.record.run_id,
  trial_ids: request.trial_ids, source_fingerprint: inspected.fingerprint};
const record = validateRunRecord({...request.original.record,
  run_id: request.run_id, harbor_job_config: inspected.effective_config,
  operator_selection: selection});
const store = new FilesystemObjectStore(`${directory}/store`);
const key = `runs/${record.run_id}/run.json`;
assert.equal((await createJson(store, key, record)).created, true);
assert.equal((await createJson(store, key, record)).created, false);
const stored = validateRunRecord(await readJson(store, key));
assert.deepEqual(stored, record);
const view = {run_id: record.run_id, operator_selection: selection, children: [],
  assembly: {availability: 'none', result: null},
  incurred: null, selected_cost_usd: null};
replacementViewSchema.parse(view);
const input = {trial_ids: request.trial_ids, cost_ceiling_usd: 10};
const publicHash = reviewFingerprint(inspected.fingerprint, input);
assert.match(publicHash, /^[0-9a-f]{64}$/);
assert.notEqual(publicHash, reviewFingerprint(inspected.fingerprint,
  {...input, cost_ceiling_usd: 11}));
// Unpublished v1 hard cutover: reject bare source hashes at every boundary.
const bare = response.fingerprint.slice('sha256:'.length);
await output({...response, fingerprint: bare});
await assert.rejects(launch.replacementReview(request), {status: 503});
const oldSelection = {...selection, source_fingerprint: bare};
assert.throws(() => validateRunRecord({...record, operator_selection: oldSelection}));
assert.throws(() => replacementViewSchema.parse(
  {...view, operator_selection: oldSelection}));
await assert.rejects(createJson(store, key,
  {...record, operator_selection: oldSelection}));
assert.deepEqual(validateRunRecord(await readJson(store, key)), stored);
console.log(JSON.stringify(stored));
"""
    evidence = tmp_path / "evidence/runs" / request["original"]["record"]["run_id"]
    evidence.mkdir(parents=True)
    (evidence / "run.json").write_text(json.dumps(request["original"]["record"]))
    job = evidence / "job"
    job.mkdir()
    for name in ("config", "lock", "result"):
        (job / f"{name}.json").write_text(json.dumps(request["original"][name]))
    for trial in request["original"]["trials"]:
        folder = job / trial["trial_name"]
        folder.mkdir()
        (folder / "result.json").write_text(json.dumps(trial))
    payload = tmp_path / "native-response.json"
    payload.write_text(
        json.dumps({"request": request, "response": response, "python": sys.executable})
    )
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", script, str(payload), str(tmp_path)],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    return json.loads(completed.stdout)
