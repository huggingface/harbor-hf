---
title: Agent Workbench
author: Harbor-HF maintainers
date: 2026-09-04
tags: [agents, workbench, harbor, security]
---

# Agent Workbench

Agent Workbench is the authenticated `/workbench` page for a generic command-line
Harbor agent. It restores the useful configure, test, and run flow without
restoring the old profile or worker systems.

## Flow

The page has three stages:

1. **Configure:** Edit setup and run commands, environment bindings, and output
   paths. The service compiles the recipe and shows the exact Harbor agent.
2. **Test:** Run only the setup command in a disposable CPU environment. This
   stage has no benchmark, model request, inference credential, Bucket mount, or
   worker authority.
3. **Run:** Select a reviewed benchmark, model route, cost limit, and result
   role. Submit the exact tested recipe through `POST /api/v1/runs`.

The browser saves incomplete recipe and run-form edits in local storage. It does
not save setup approval, setup state, or launch confirmation. Reloading the page
therefore keeps the draft but requires a fresh confirmation. Recipe commands and
literal values must not contain secrets.

A setup pass is temporary evidence. It does not create or approve a profile. It
does not start a benchmark. The pass is valid for one hour, for the same actor,
recipe digest, and compiler revision. A service restart makes a recovered setup
record non-attestable, so the operator must run the test again.

## Recipe

The authoritative schema is
[`agent-workbench-v1.schema.json`](../packages/contracts/schemas/agent-workbench-v1.schema.json).
A recipe contains:

- a portable name;
- setup and run shell commands;
- a `chat-completions` or `responses` route type;
- a setup timeout from 30 to 3,600 seconds;
- typed environment bindings; and
- a required result path and optional ATIF trajectory path below
  `/logs/agent`.

Environment sources are:

| Source | Setup | Run | Value |
| --- | --- | --- | --- |
| `literal` | yes | yes | Non-secret recipe text |
| `workspace_path` | yes | yes | Writable task workspace |
| `logs_path` | yes | yes | Agent output directory |
| `agent_home` | yes | yes | Managed agent home |
| `model_name` | yes | yes | Model selected for the run |
| `instruction_path` | no | yes | File that contains the task instruction |
| `model_base_url` | no | yes | Model route injected for the run |
| `model_api_key` | no | yes | Inference credential injected for the run |

The compiler rejects duplicate names, shell-reserved names, Harbor control
names, credential-like literal names or values, paths outside the managed
roots, duplicate output paths, and run-only bindings in setup commands.
Instructions stay in a file. The compiler does not put instruction text in a
shell command.

## Harbor integration

The compiler produces one Harbor agent fragment with this fixed import:

```text
harbor_hf_agents.command_agent.agent:CommandAgent
```

The fragment goes into the same Harbor `JobConfig` that a reviewed agent preset
uses. The normal run record, parent Job, Harbor folder, trial lifecycle, retry
behavior, result projection, cost stop, and controls apply. There is no
Workbench-specific run endpoint, task loop, retry loop, worker, profile,
promotion, preparation Job, or publication record.

The server accepts a Workbench run only when the recipe has both
`model_base_url` and `model_api_key` bindings. It recompiles the submitted
recipe, checks the exact setup attestation, and creates one normal run. The
inference credential appears only as the existing runtime template in the
Harbor agent environment. It is not stored in the recipe, run record, request,
Job label, or setup Job.

A diagnostic role is the safe default. Final runs can enter the public
leaderboard only when the selected benchmark is eligible and Harbor records at
least one numeric reward.

## Setup runners

Local development uses Docker. The container has bounded CPU, memory, process,
time, log, file-count, and file-preview limits. It mounts only temporary
workspace, logs, agent-home, and recipe paths.

A hosted deployment can use one temporary Hugging Face Job for each setup test.
The Job uses:

- `cpu-basic` on `amd64`;
- an immutable reviewed image;
- one attempt;
- no secrets;
- no volumes;
- no Space attachment; and
- opaque ownership and recipe labels.

The control service verifies the returned Job specification. If verification
fails after creation, it cancels that Job. Cancellation targets only the Job
that belongs to the actor-owned setup record. Setup logs are bounded to 2 MiB
per stream. At most 1,000 files and 1 MiB of text previews are retained by the
control process.

The hosted runner needs these variables:

```text
HARBOR_HF_WORKBENCH_RUNNER=hf-jobs
HARBOR_HF_WORKBENCH_IMAGE=<image>@sha256:<digest>
```

Production rejects a hosted Workbench image that does not use an immutable
digest. `disabled` is the production default. Development defaults to `docker`.

## Command-line use

Set the normal control URL and bearer token in the shell. Then use:

```bash
harbor-hf workbench preview recipe.json
harbor-hf workbench setup start recipe.json --yes --wait
harbor-hf workbench setup list
harbor-hf workbench setup status <setup-test-id>
harbor-hf workbench setup wait <setup-test-id>
harbor-hf workbench setup logs <setup-test-id>
harbor-hf workbench setup files <setup-test-id>
harbor-hf workbench setup file <setup-test-id> <file-id>
harbor-hf workbench setup cancel <setup-test-id> --yes
```

Submit the exact passed recipe through the normal run command:

```bash
harbor-hf run submit \
  --benchmark terminal-bench-2-1 \
  --preset one-task-1-trial \
  --model publisher/model \
  --provider provider \
  --harness recipe.json \
  --setup-test <setup-test-id> \
  --cost-ceiling-usd-per-trial 0.25 \
  --role diagnostic \
  --yes
```

`--harness` and `--setup-test` must be used together. A Workbench submission
cannot also select an agent preset and must use reasoning effort `off`.

## Starter recipes

The page keeps the historical Fast Agent and FX starter recipes with their
pinned versions and checksums.

The Fast Agent starter has direct model base URL and API key bindings, so it can
complete the full setup and Harbor run flow.

The FX starter uses its original Vercel AI Gateway assumptions. It can be
setup-tested, but it cannot start a Harbor run until its recipe declares the
direct model route and credential bindings required by Harbor-HF. This prevents
an inference credential from going to an unintended endpoint.
