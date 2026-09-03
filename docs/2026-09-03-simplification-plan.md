---
title: Simplify Harbor-HF around Harbor
author: Harbor-HF maintainers
date: 2026-09-03
tags: [architecture, profiles, runs, harbor, cleanup]
---

# Simplify Harbor-HF around Harbor

## In short

Harbor-HF is a control plane that runs Harbor benchmarks on Hugging Face
infrastructure. It grew quickly while the maintainers needed benchmark results
for a paper, and it now re-implements most of what Harbor already does. This
plan makes Harbor-HF a thin layer again. Harbor owns the job loop, retries,
resume, the reproducibility lock, and the result files. Harbor-HF owns the
hosted Space with its submission API and form. It also owns credential handling
and Bucket storage, plus a cost ceiling on each trial and the leaderboard.

Each benchmark run becomes one Harbor process inside one HF Job. That Job
mounts the Bucket and writes Harbor's job folder there, and it starts one child
Job per trial through Harbor's `hf-sandbox` environment. The Space submits runs,
restarts a parent Job that stopped early, and polls the Bucket to show status.
One `run.json` per run replaces the five profile kinds. About 90,000 lines of
Python that no deployment uses are deleted. Everything lands in one cutover.

**Status.** Proposed and reviewed by the maintainers on 2026-09-04. The design
decisions below are settled. Two paid tests and one token decision, listed under
preconditions, must happen before code is written.

## Problem

A person who wants to submit a run today must first pick a benchmark profile and
a model profile, then a harness profile and a launch policy. The form refuses
the submission unless the launch policy lists that exact combination, and a
deployment profile that also lists the combination must exist. None of these
profiles is something a submitter cares about. They want to name a model and an
agent and pick a benchmark size. After that they expect a score without reading
a profile catalog first.

The profiles exist because Harbor-HF runs its own job loop. The trial worker in
`packages/harbor-hf-agents` writes a one-trial Harbor config with `n_attempts`
and concurrency both set to 1 and with retries disabled. The TypeScript control
service then rebuilds concurrency, retries, budget holds, and resume on top of
HF Jobs. Every rule that Harbor would have applied inside one job now needs a
durable record and a profile field.

The table shows where the code is. Counts are source lines and exclude generated
files and tests.

| Area | Lines | Notes |
| --- | --- | --- |
| `src/harbor_hf` | 40,412 | No Dockerfile copies it. The `harbor-hf` CLI does not import it. |
| `tests/` for `src/harbor_hf` | 49,079 | CI enforces 85% coverage on this code. |
| `packages/control-core` | 11,890 | About 2,600 lines handle retries and the budget bookkeeping behind them. |
| `apps/control-api` and `apps/control-web` | 15,000 | The launch form is about 490 lines. |
| `packages/harbor-hf-agents` | 11,544 | 2,700 lines are an OCI runtime built on proot. |
| `profiles/` | 62 files | Five kinds. A deployment spec has 60 fields. |
| `schemas/` | 23 files | Ten files are referenced by nothing. |

The Python package is the largest item. It is the previous control plane and
three generations of worker. The control Space image copies `apps/` and
`packages/` together with the `profiles/` directory. The trial worker image
copies `packages/harbor-hf-agents`. Neither copies `src/`. The only live file in
that directory is `cli.py`, a 434-line HTTPS client that imports nothing else
from the package.

The live TypeScript code has its own duplication. The run lock stores each
selected profile spec three times. Two copies sit under `profiles` and
`execution`, and a pointer copy sits under `source_profiles`. The profile
compatibility rule is implemented four times, in the profile resolver and the
execution contract on the server, and in the launch helper and a form effect in
the browser. Retries take five separate paths, and a three-level chain of
continuation and repair records exists only for runs created before the last
profile cutover. The publication step writes five Parquet tables that no code in
the repository reads.

The profile churn is visible in the history. Of the 336 commits since August 1,
54 touch `profiles/`. Most of them pin a new worker image digest after an agent
fix, because the Harbor version and the worker revision live in every deployment
profile.

## Existing Harbor coverage

Harbor is the benchmark framework that Harbor-HF wraps. The items below are in
Harbor `origin/main` as of this date. File paths refer to the Harbor repository.

Harbor defines a job as a `JobConfig` in `src/harbor/models/job/config.py`. The
config carries the dataset reference, task include and exclude globs,
`n_attempts`, `n_concurrent_trials`, a `RetryConfig` with typed include and
exclude lists and backoff, and one `AgentConfig` per agent. The CLI reads the
config from a local path or an HTTPS URL, and flags override file values.

Harbor resumes a partial job from disk. Opening a `Job` in an existing job
directory keeps every trial that has a `result.json` and reruns the rest. The
`harbor job resume` command adds `--filter-error-type`, which reruns only trials
whose recorded exception matches. This covers the infrastructure retry case that
Harbor-HF implements in `reconciler.ts` and `service.ts`.

Harbor writes a reproducibility lock. `lock.json` records the Harbor version and
commit together with the task digests. It also holds the resolved agent config
and the environment config for each trial. `result.json` records reward, token
counts, cost, timing, the agent version, and the model name and provider for
each trial. The trajectory lands in `agent/trajectory.json` in ATIF format.

Harbor has an HF Jobs environment. `src/harbor/environments/hf_sandbox.py` runs
each trial as a Hugging Face Sandbox backed by HF Jobs, with a `flavor` kwarg
for hardware and a `job_timeout` kwarg. Maintainers from Hugging Face added it
and fixed its shell handling upstream. It replaces the proot runtime in
`job_oci_runtime.py`.

Harbor has built-in agents for pi, hermes, openclaw, codex, opencode, openhands,
mini-swe-agent, kimi-code, qwen-coder, fx and terminus-2. Each agent takes
`model_name` in `provider/model` form and a `version` kwarg that pins the
install. Provider API keys and base URLs resolve from environment variables
through the table in `src/harbor/agents/model_connection.py`.

Harbor exports traces to a Hugging Face Dataset with `--export-push`, and it has
a leaderboard CLI under `harbor hub leaderboard`.

## Remaining wrapper scope

Four things remain for a wrapper to do.

Harbor has no HF Inference Providers routing. The model name convention is
`provider/model`, and there is no `model:provider` suffix and no default base
URL for the Hugging Face router. Harbor-HF currently handles this with the
inference bridge in `hf_inference_bridge.py`.

Harbor has no cost ceiling. It accounts tokens and cost per trial, and a few
agents accept their own budget flags, but nothing stops a job when spend crosses
a limit.

Harbor has no hosted control plane on Hugging Face. Its own remote dispatch runs
on Harbor-hosted infrastructure. A Space that accepts submissions and holds
credentials, and that publishes results afterwards, is Harbor-HF's job.

The `hf-sandbox` environment has gaps. It needs a prebuilt `docker_image` in
`task.toml` and cannot build a task Dockerfile. It ignores user switching and
declares no network policy capability.

## Target design

### Execution model

Harbor runs inside one parent HF Job per benchmark run. The Space never runs
Harbor itself. A Space restarts on every deploy, and a restart would stop every
benchmark in progress, so the Space is the wrong place for a process that lives
for a day.

The parent Job mounts the Bucket and uses a folder in it as Harbor's
`jobs_dir`. Harbor writes `config.json`, `lock.json`, each trial's `result.json`
and the trajectories straight into the Bucket as it works. There is no copy
step and no storage on the Space. For each trial Harbor starts one child Job
through `hf-sandbox`, waits for it, collects the result and moves on. The parent
Job runs on a small CPU flavor and mostly waits, so it costs little.

An HF Job stops after 24 hours. A full Terminal-Bench run with five trials per
task can take longer, so the Space has one control rule. If a run is not
finished and no parent Job for it is alive, start one with the same `jobs_dir`.
Harbor keeps every trial that has a `result.json` and reruns the rest. The rule
is idempotent. Each parent Job carries a label with its run id, so a duplicate
start after a lost response finds the live Job and does nothing. This one rule
replaces the reconciler, the five retry paths and the continuation chain.

The parent Job holds a token that can start Jobs and write to the Bucket. Today
no Job receives such a token, and the earlier design treated that as a rule.
This plan changes the rule, because the parent Job is now the orchestrator. The
token arrives as a Job secret at launch and never appears in the run record.

The parent image is the existing trial worker image with Harbor installed. It
is the only image to pin, and one tag per Harbor version replaces the digest
pins in 22 deployment profiles.

### Run record

A run is one folder in the Bucket with two small files that Harbor-HF writes and
one folder that Harbor writes. `runs/<run_id>/run.json` holds what the submitter
chose in the form and the Harbor `JobConfig` that Harbor-HF derived from those
choices. It never changes after submission. `runs/<run_id>/state.json` holds the
facts that only Harbor-HF knows, such as a cancel or pause by an operator and
the list of parent Jobs started for the run with their start times. The Space
rewrites it when an operator acts or when it starts a parent Job. The parent Job
writes Harbor's job folder at `runs/<run_id>/job/`, and Harbor-HF never writes
into that folder.

The status shown in the panel is computed from these files. A run with
`run.json` and no parent Job yet is queued. A run with a live parent Job is
running. A run whose job-level `result.json` reports every trial as done is
finished. A run whose `state.json` says cancelled is cancelled.

The submission form has four groups. The maintainers agreed on these fields so
that a person can submit a run without creating anything in another place
first.

| Group | Fields |
| --- | --- |
| Benchmark | Benchmark name and a size preset. |
| Model | Model id, reasoning effort. Runtime is fixed to Inference Providers. |
| Harness | Agent name, agent version. |
| Cost control | Cost ceiling per trial in USD. |

The size preset fixes the task selection and the number of trials per task.
The first presets are one task with one trial, all tasks with one trial, and
all tasks with five trials. Fixed presets keep runs comparable across
submitters. A preset is a plain `JobConfig` fragment with the dataset
reference, the task filter, `n_attempts` and a concurrency limit.

The harness list comes from Harbor. Its `harbor agent schema` command lists each
agent and its accepted options, so the form reads that list instead of keeping
its own catalog. An agent preset is the agent name plus a pinned version.
Each agent names its reasoning option differently, for example `thinking` for
pi and `reasoning_effort` for codex, so the agent preset also names the option
that carries the form's reasoning effort value.

Presets live in the repository under `presets/benchmarks/` and
`presets/agents/`, one JSON file each, and the Space loads them at startup.
Adding a benchmark or an agent means adding one file. No code changes.

A submission carries an idempotency key, as today. The run id is derived from
that key, so a repeated request returns the existing run instead of starting a
second one.

```json
{
  "run_id": "run-…",
  "created_at": "2026-09-04T12:00:00Z",
  "submitted_by": "<operator>",
  "role": "final",
  "harbor_version": "0.22.0",
  "submission": {
    "benchmark": { "name": "terminal-bench-2-1", "preset": "all-tasks-5-trials" },
    "model": { "id": "openai/gpt-oss-120b", "provider": "together", "reasoning_effort": "high" },
    "harness": { "agent": "pi", "version": "0.84.4" },
    "cost_ceiling_usd_per_trial": 2.0
  },
  "harbor_job_config": {
    "datasets": [{ "name": "terminal-bench@2.1" }],
    "n_attempts": 5,
    "n_concurrent_trials": 8,
    "agents": [
      {
        "name": "pi",
        "model_name": "openai/openai/gpt-oss-120b:together",
        "kwargs": { "version": "0.84.4", "reasoning_effort": "high" }
      }
    ],
    "environment": { "type": "hf-sandbox", "kwargs": { "flavor": "cpu-upgrade" } }
  }
}
```

The `submission` block is what the person chose. The `harbor_job_config` block
is what Harbor received, stored as Harbor accepts it. Harbor-HF validates it
with Harbor's own config parser and adds no field of its own to it. The run
record together with Harbor's `config.json`, `lock.json` and `result.json` is
the full reproducibility record.

Reasoning effort lives on the agent config only, because that is where Harbor
puts it. The model profile's `revision` field goes away. For a provider-routed
model the revision is unknown, and a future Inference Endpoint records it in
its own config.

The `role` field is optional and defaults to `final`. A run marked `diagnostic`
stays off the leaderboard. This replaces `publication_role` from the launch
policy.

The model, harness, deployment, launch policy and capacity profile kinds are
removed. No run record field may duplicate a `JobConfig` field.

### Routing and credentials

Harbor has no general Inference Providers routing yet. Agents that use an
OpenAI-compatible server receive `openai/<model>:<provider>`, the fixed Hugging
Face router URL, and the inference token. The router accepts the `:provider`
suffix in the model field. Pi already has a built-in `huggingface` provider, so
its model name is `huggingface/<model>:<provider>` and its `HF_TOKEN` environment
value is the inference-token template. This keeps Pi's provider price metadata
available for Harbor cost accounting instead of creating a zero-price custom
model. When Harbor gains a general `huggingface` provider with the router as its
default base URL, the other agents can use the same route.

Credentials never touch the run record. The Space holds two tokens as Space
secrets. The control token can start Jobs and write the Bucket, and it goes to
the parent Job as a Job secret. The inference token goes the same way and
reaches each child Job through Harbor's agent environment. Harbor scrubs it
from logs.

Version one uses only these two tokens. Submitter-supplied keys for providers
such as OpenAI and Anthropic come next, because those models are the most
requested. They will arrive with the submission and be stored encrypted in the
Bucket with a key the Space holds, because a parent Job restart after 24 hours
needs them again.

### Cancel, pause, and capacity

Cancel stops the parent Job through the Jobs API. Harbor receives SIGTERM and
stops the child Jobs it started. The Space then lists Jobs that carry the run id
label and cancels any child that is still alive, so that no orphan keeps
running. The same orphan check runs whenever a parent Job ends for any reason.
This needs the child Jobs to carry the run id label, which is one of the
preconditions below.

Pause is the same stop with the `paused` flag set in `state.json`. The control
rule skips paused runs, so no new parent Job starts. Resume clears the flag and
the control rule starts a parent Job on its next pass. Harbor resumes from the
trials that already have a `result.json`.

Capacity is bounded by two numbers. A configured cap on live parent Jobs, and
the fixed `n_concurrent_trials` in each preset. Their product bounds the child
Jobs in the namespace. A submission above the cap waits in the queued state
until a parent Job slot frees up. This replaces the token bucket in
`job-admission.ts`.

### Cost ceiling

The cost ceiling is enforced inside the parent Job. A Harbor job plugin reads
each finished trial's `cost_usd` and stops the job when the sum crosses the
ceiling. Whether the plugin hooks allow a stop mid-run is one of the
preconditions below. If they do not, a small wrapper around the `harbor`
process watches the trial results and sends SIGTERM, which Harbor handles
cleanly. The ceiling is a candidate for an upstream `max_cost_usd` field later.

The ceiling counts inference cost only, because that is what Harbor reports.
The compute cost of the parent and child Jobs is shown in the panel as an
estimate from the flavor price and the Job runtime reported by the Jobs API. It
is not enforced in version one.

### Status and the control panel

Harbor does not provide a panel across runs. `harbor view` shows one job folder,
and Harbor Hub is a hosted service on Harbor's own infrastructure. The panel
that lists what is running now stays in the Space.

The panel needs no store of its own. The list of runs is the list of
`runs/*/run.json` files in the Bucket. The state of a run is its job-level
`result.json`, which Harbor updates with pending, running and finished counts.
Whether a run is live comes from the HF Jobs API through the run id label on
the parent Job.

The Space polls the Bucket for runs that have a live parent Job, every 15 to 30
seconds. One file per live run is enough, because Harbor's job-level
`result.json` contains the results of all finished trials and the pending and
running counts. The Bucket store keeps the content hash of each file it has
read, so an unchanged file is not downloaded again. Trial folders are read only
when someone opens a trial in the panel. The Space knows every run without
listing the Bucket, because it wrote `run.json` itself. It lists the `runs/`
folder once at startup to rebuild SQLite. Finished runs never change, so they
are read once. When the Jobs API
reports that a parent Job ended, the Space reads that run one last time and
applies the control rule. There is no push channel from the Job. Polling cannot
miss a file, and a push would need a poll as backup anyway. A small notice from
a Harbor trial hook can be added later for faster updates without changing the
design.

The Bucket stays the only durable store and SQLite stays a cache that can be
deleted and rebuilt at any time. `HuggingFaceBucketStore` and the rebuild loop
in `projection.ts` stay almost as they are. The 25 record kinds and 24 tables
become three tables, for runs, trials and parent Jobs. The 369-line invariant
checker goes, because there are no cross-record invariants left.

### Leaderboard

The leaderboard is a query over finished runs with `role` set to `final` and a
preset that covers all tasks. Rows group by benchmark preset, agent preset,
model id and reasoning effort. Pass rate is the mean over all trials, and
`n_attempts` is shown next to it so that a one-trial run and a five-trial run
are never read as equal. The Parquet tables, the result catalog, the
publication receipt and the supersession chain are removed.

Historical runs in the Bucket stay as a read-only archive under their existing
paths. They are not migrated.

### Retained components

The `harbor-hf` CLI stays as a thin HTTPS client for the control API. It gains
`harbor-hf submit --config job.yaml`, which sends a Harbor `JobConfig` file to
the Space as it is, and keeps `harbor-hf run status`. The package loses the 66
dead modules that share its directory and their dependencies, such as `pyarrow`
and `zstandard`.

Authentication in `auth.ts` is unchanged. The installer under
`scripts/control-service` still provisions the Space and the Bucket and can
shrink in a later change. In `packages/harbor-hf-agents` only the four ATIF
converters for pi, hermes, openclaw and dsh remain, as custom agents behind
Harbor's `import_path`, until they move upstream. Everything else uses Harbor's
built-in agents.

## Upstream contributions

Several parts of the current wrapper belong in Harbor. Hugging Face maintainers
already own the `hf-sandbox` path there. Opening an issue or a pull request in
the Harbor repository needs explicit confirmation from the maintainers for that
specific change, as `AGENTS.md` states.

The first candidate is Inference Providers routing, a default base URL for the
`huggingface` provider in `model_connection.py` with the `:provider` suffix
passed through. Once it lands, most of the 13 agent wrappers in
`packages/harbor-hf-agents` lose their reason to exist.

The second is the set of `hf-sandbox` fixes that are not yet upstream. Six fix
branches exist in a maintainer's Harbor checkout. They cover startup readiness,
working directory creation, mounts and private task environments. The prebuilt
image requirement and user switching are the two remaining gaps.

The third is trajectory export. The four ATIF converters in this repository
belong in the upstream agents, and branches already exist for pi and openclaw.

The fourth is a per-trial cost ceiling as a `JobConfig` field.

## Cutover

The change lands as one cutover. A staged rollout would keep the profile
catalog, the old workers and the new run record alive at the same time, and the
compatibility code between them would outlive the rollout. Harbor-HF has no
external users of its API yet, and the historical runs in the Bucket stay
readable without any new code, so there is nothing that a staged path would
protect.

The cutover removes every module in `src/harbor_hf` except `cli.py`, together
with its Python tests, the 85% coverage gate in `.github/workflows/ci.yml`, the
ten unreferenced files in `schemas/`, the empty `space/` and `apps/results-web`
directories, `scripts/build_space_release.py` and the one-shot migration
scripts. The five profile kinds and the four compatibility implementations are
replaced by the run record and the presets, and the launch form shrinks to the
four groups above. The proot runtime and both workers in
`packages/harbor-hf-agents` go, together with the inference bridge and the
retry and continuation machinery in `control-core`. The Parquet publication
path goes. `docs/architecture.md` is rewritten and `docs/run-spec.md` is
retired in the same change. The untracked `mutants/` directories, about 774 MB,
can be deleted at any time.

The change is large, so it should be one pull request with a reviewable
sequence of commits. Nothing deploys until the whole
pull request merges. Before the pull request, one implementation specification
names the files, the record shapes and the API routes, so that the work does
not make design decisions on its own.

## Tests

The pull request carries unit tests for submission, the control rule, the
status computation and the orphan cleanup, all against a fake Jobs API and a
local object store. Before merge, one end-to-end run with the one-task preset
goes through the real Space and real HF Jobs, and its run folder in the Bucket
is inspected by hand. That single run is the merge gate.

## Preconditions

Three things must happen before code is written.

The maintainers must approve that the parent Job holds a token with Jobs and
Bucket write scope. This reverses the earlier rule that no Job receives a
credential.

Two paid tests must run. The first is one `harbor run` with `hf-sandbox` from a
laptop on a few Terminal-Bench tasks. It confirms that HF Jobs can pull the task
images and that trials complete. The second is one HF Job that mounts a Bucket,
runs Harbor with `jobs_dir` on the mount, and starts a child Job from inside. It
confirms that the mount is writable and fast enough for Harbor's file writes.
If the second test fails, the fallback is to run Harbor on the Space with
persistent storage, at the cost of restarts on every deploy.

The Harbor plugin hooks must be checked for a mid-run stop, for the cost
ceiling.

Three smaller facts must be confirmed during the tests. That Harbor updates the
job-level `result.json` while the run is in progress, because the panel depends
on it. That `hf-sandbox` can put a label on the child Jobs it starts, because
orphan cleanup depends on it. And how long agent installation takes inside a
child Job, because it happens once per trial.

Two facts are already known. `hf-sandbox` runs only tasks that ship a prebuilt
image, and this is a general requirement for every benchmark. The current
worker has the same requirement, and all 89 Terminal-Bench 2.1 tasks have run
through it, so that benchmark is covered. What changes is the image source.
Today the trial Job pulls a pinned digest from a mirror, and `hf-sandbox` pulls
by tag from the registry named in `task.toml`. The current worker also rejects a
separate verifier image, and `hf-sandbox` behavior for that case is unknown.
Terminal-Bench does not use one.

The Harbor checkout used while writing this plan was 16 days behind
`origin/main`. Implementation work must start from a current checkout.

## Later work

These items are recorded so that they do not creep into the cutover.
Submitter-supplied provider API keys. Inference Endpoints as a runtime, with
the model revision recorded on the endpoint. Running a harness from a fork
commit for harness development. A trial hook that notifies the Space for faster
panel updates. Shrinking the installer.

## Related documents

This plan supersedes the design in [architecture](architecture.md) and the [run
specification](run-spec.md). It also supersedes the [reusable harness profiles
plan](2026-08-28-reusable-harness-profiles-plan.md). The [control service
specification](CONTROL_SERVICE.md) remains the reference for the Space runtime,
authentication, the Bucket store, and the projection until the cutover updates
its profile and run sections. The [task result retry
plan](2026-09-01-task-result-retry-plan.md) describes the retry mechanism that
the cutover removes. The Harbor boundary rules in [AGENTS.md](../AGENTS.md)
apply to all work under this plan.
