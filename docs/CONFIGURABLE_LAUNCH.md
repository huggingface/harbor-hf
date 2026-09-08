---
title: Configurable launch
author: Harbor-HF maintainers
date: 2026-09-08
tags: [launch, agents, configuration]
---

# Configurable launch

Open **Runs → New Job** to edit a native Harbor `JobConfig`. Start from a
benchmark preset or enter sources directly. Add an agent card for each requested
implementation, CLI version, model, and provider. The form and JSON editor change
the same configuration. Existing preset submission and Agent Workbench remain
available; they use the same run authority and Harbor worker.

## Sources and agents

The page supports package datasets, single package tasks, Git datasets, and Git
tasks. Enter exact references; source autocomplete is not available. Package
sources require a `sha256:` content ref. Git sources require a full commit. Only
public, credential-free GitHub HTTPS sources are admitted. Paths must stay inside
the source repository. For a Git task, the pinned native field is
`git_commit_id`, not `git_ref`.

Dataset include/exclude globs and task limits remain native Harbor fields. Harbor
resolves the task list and expands agents and attempts. The number of cards is
not the resolved task or trial count. Concurrency does not multiply scored trials.

Agent choices come from the reviewed installed presets and native ACP. The
service reads option schemas from the pinned Harbor classes. It does not import
an arbitrary class named in a request. Agents without a native option schema can
use their reviewed preset options, but cannot accept new arbitrary kwargs.

### Test a Pi or OpenClaw version

1. Load a benchmark preset.
2. Add an agent and select Pi or OpenClaw.
3. Open **Agent configuration** and set the native `version` option. Use an exact
   CLI release, not `latest`. Set `thinking` if the implementation declares it.
4. Select an HF model and one of its live provider mappings. Changing the model
   clears the provider. There is no automatic provider substitution.
5. Add another agent card to compare a different version in the same Harbor job.
6. Select sandbox hardware, attempts, concurrency, and the post-trial cost limit.
7. Select **Validate**, inspect the native counts and effective configuration,
   then select **Launch**.

Pi uses the reviewed installed Pi integration and a native `huggingface/` model
route. Other admitted agents use the reviewed OpenAI-compatible HF route. These
routes are explicit; submission does not silently rewrite a model route or discard
`model_api`. A provider mapping is not proof of runtime protocol compatibility.

A Pi extension is not an ACP agent. Loading an arbitrary extension through a
field called `config` is not supported. A specialized Pi integration must first be
reviewed and included in the parent package and agent presets. Its native option
schema then supplies the form. Changing an existing supported CLI version does
not by itself require another agent implementation.

### Load an ACP agent from Git

Select **Custom Git source (ACP)**. Fill the native `kwargs.source` fields:
`repo_url`, `ref`, `source_dir`, and `manifest_path`. The manifest belongs to
Harbor, not Harbor-HF. At this pin, the source contract supports Python 3.12 with
uv and ACP. It is not a generic Node.js or shell harness loader.

The source object must match an entry in the operator-managed
`HARBOR_HF_APPROVED_AGENT_SOURCES` JSON variable. Its default is `[]`, which admits
no custom source. For example, after review an operator can configure:

```json
[
  {
    "repo_url": "https://github.com/<namespace>/<agent-repository>.git",
    "ref": "<full-commit-sha>",
    "source_dir": ".",
    "manifest_path": "harbor-agent.json"
  }
]
```

Use the same native object in the agent's `kwargs.source`. No source code runs
during Validate. Harbor fetches, verifies, installs, and runs the approved source
through its native ACP implementation during execution. Private source credentials
are not supported here. Agent code can read its inference credential. It must
receive neither the control credential nor the canonical Bucket mount.

## HF restrictions

- Sandbox flavors: `cpu-basic` and `cpu-upgrade`.
- `environment.kwargs.job_timeout` is an **idle timeout**, for example `30m`.
  It does not replace agent, trial, or parent wall-clock limits.
- Each task needs a prebuilt Docker image. Image builds, resource overrides, and
  enforced network allowlists are not offered by this page.
- There are no separate hosted maximums for source count, agent count, attempts,
  concurrency, or retries. Harbor validates concurrency and retry values. Hosted
  diagnostic jobs require at least one agent and one attempt; Harbor rejects a
  plan without tasks.
- Inspection admits at most 10,000 resolved trials. Native planning builds a
  `TrialConfig` and lock entry for each trial in control-Space memory. This check
  runs before task downloads and plan allocation. It bounds planning work, not
  spending or runtime concurrency. The subprocess timeout and response limit
  remain in place. Higher concurrency and retries can increase cost before a stop.
- Nonsecret environment keys: `LANG`, `LC_ALL`, `TZ`, `NO_COLOR`, and `TERM`.
  Credential literals, user expansion templates, local paths, external registries,
  arbitrary imports, MCP servers, trajectory loading, and agent skills are rejected.
- Dataset executable metrics and attached dataset files need separate review.
  They can introduce code into the privileged parent and are not admitted by this
  launch path. Normal native built-in metrics remain Harbor-owned.
- Direct configuration creates diagnostic runs. Final leaderboard submissions
  remain on the reviewed preset path. Editing a preset in New Job does not retain
  leaderboard eligibility.

The post-trial USD limit is not a strict payment ceiling. Concurrent trials and
retries can spend before a stop, and HF infrastructure adds cost. Estimates and
ETA remain unavailable without measured evidence.

## Validation and API

| Operation | Interface |
| --- | --- |
| Read reviewed agent options and native job schema | `GET /api/v1/agents` |
| Read current model providers | `GET /api/v1/model-providers?model=...` |
| Inspect a native configuration without creating a run | `POST /api/v1/runs/validate` |
| Revalidate and submit a diagnostic configuration | `POST /api/v1/runs/config` |

Both POST bodies are native `JobConfig`, without another request envelope. The
submission endpoint retains `Idempotency-Key` and
`X-Harbor-HF-Cost-Ceiling-USD-Per-Trial`. The browser also sends
`X-Harbor-HF-Validation` with the fingerprint returned by Validate. A configuration
or policy change returns 409 and requires another review. CLI callers can still
use `harbor-hf submit --config ...`; the server performs fresh inspection before
creating the run.

Validation returns counts from native `JobPlan`, the effective native
configuration, the Harbor revision, warnings, and checks not performed. The
output path uses a fixed preview run ID; the real run receives its own managed
path and ownership label. Credential status means the two distinct operator
credentials are configured. It does not mean they were authenticated.

Validation does not install agents, execute repository code, create HF Jobs,
contact a model for inference, verify registry access, or prove sandbox startup.
Native planning and task downloads run in a temporary directory through a bounded
Python subprocess. The process receives no inherited credentials, accepts at most
one inspection at a time, and has a 90-second timeout and a 1 MiB response limit.
The control image includes the same pinned Harbor package as the parent. Catalog,
validator, and parent revision mismatches block execution.

Validation requires operator authentication and normal browser CSRF protection.
It is allowed while writes are disabled. Launch additionally requires enabled
writes and configured credentials. Identical idempotent submissions return the
same run; conflicting reuse is rejected.

The browser saves only bounded drafts that pass the shared credential-material
check. It never saves a successful validation or launch authorization. Invalid
JSON stays visible and blocks both actions. Unset, null, false, zero, and empty
values stay distinct. No draft is placed in a shareable URL.

## Results and deployment

Native configuration and trial results identify every agent and model. Mixed
runs do not fill singular submission metadata with the first agent. The trial
table shows native agent/model assignments and Harbor's reported agent version.
The existing Bucket layout, projection, parent lifecycle, cost stops, and result
files do not change.

For local development, install the pinned worker dependencies with
`uv sync --project packages/harbor-hf-agents --all-groups`. The default inspector
is that package's `.venv/bin/python`. The control image sets
`HARBOR_HF_LAUNCH_PYTHON=/opt/harbor-launch/bin/python`.

Deployment and paid remote canaries require separate approval. Before enabling
writes, verify the parent image revision, control revision, source approvals,
credential separation, sandbox cleanup, and real model/agent compatibility. A
local validation pass is not that evidence.
