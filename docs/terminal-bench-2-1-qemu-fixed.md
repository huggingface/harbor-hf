---
title: Terminal-Bench 2.1 QEMU-fixed diagnostic presets
author: Harbor-HF maintainers
date: 2026-09-09
tags: [benchmarks, presets, diagnostic, provenance]
---

# QEMU-fixed diagnostic presets

These are **diagnostic only and not leaderboard eligible**. Publication does not
launch a smoke test, authorize execution, deploy the service or publish results.
Original presets and historical results are unchanged.

| Benchmark | Preset | Tasks | Native attempts | Logical trials (one agent) | Concurrency |
| --- | --- | ---: | ---: | ---: | ---: |
| terminal-bench-2-1 | all-tasks-1-trial-qemu-fixed | 89 | 1 | 89 | 8 |
| terminal-bench-2-1 | all-tasks-5-trials-qemu-fixed | 89 | 5 | 445 | 8 |
| terminal-bench-2-1 | held-50-1-trial-qemu-fixed | 50 | 1 | 50 | 8 |
| terminal-bench-2-1 | two-tasks-2-trials-qemu-fixed | 2 | 2 | 4 | 2 |

The smoke selects `qemu-startup` and `qemu-alpine-ssh` with native
`retry.max_retries: 0`. Full variants preserve the original native configuration
except the source; all four set `leaderboard_eligible: false`. No unrelated
adaptive-rejection-sampler or three-task smoke variant was added.

## Explicit six-hour agent presets

These additional diagnostic presets leave all four presets above unchanged:

| Preset | Tasks | Native attempts | Logical trials (one agent) |
| --- | ---: | ---: | ---: |
| all-tasks-1-trial-with-6h-qemu-fixed | 89 | 1 | 89 |
| all-tasks-5-trials-with-6h-qemu-fixed | 89 | 5 | 445 |
| held-50-3-trials-qemu-fixed | 50 | 3 | 150 |

**All three additions give each trial six hours (21600 seconds) of agent
execution**, including the held-50 three-attempt addition. This replaces each
task's agent budget; it is not six hours for the whole Run and does not include
agent setup, environment build or verification. A full Run can take much longer.
This does not guarantee six hours of useful work or model/provider compatibility:
earlier errors, cancellation, agent exits and existing cost policies still apply.
No execution or increased spend is authorized by adding a preset.

Each addition stores only native Harbor settings:

```json
{
  "agents": [{ "override_timeout_sec": 21600, "max_timeout_sec": null }],
  "agent_timeout_multiplier": 1,
  "retry": { "max_retries": 0 }
}
```

Concurrency remains eight, agent setup multiplier remains two, and environment
and verifier settings remain unchanged. The existing Sandbox `job_timeout` stays
`"none"`; no parent/whole-Run time limit is added. Attempts are logical benchmark
repetitions, not retries. The source and image pins below are reused exactly, and
the held-50 selection is copied exactly from the existing one-attempt preset.
All additions remain `leaderboard_eligible: false`, including the 445-trial one;
this repaired source must not be promoted as an official final result.

The `with-6h` full-preset names sort after the existing one-attempt fixed preset,
preserving the catalog-first default used by both fresh submission forms. Users
must explicitly select a new preset. Existing saved selections remain unchanged.

Native precedence was checked at Harbor
`dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e` in
`src/harbor/models/trial/config.py`, `src/harbor/models/job/config.py`,
`src/harbor/job_plan.py` and `src/harbor/trial/trial.py`:

1. Agent `override_timeout_sec` replaces the task agent timeout.
2. `max_timeout_sec`, when supplied, caps that base **before** multiplication.
3. Explicit `agent_timeout_multiplier` takes precedence over the global multiplier.

Thus these settings resolve to `min(21600, infinity) * 1 = 21600` seconds,
not 86400 seconds. Setup and verifier use separate native fields. Reviewed all
subsequent upstream history through `191d1b98`; timing and trial expansion are
unchanged (JobConfig adds attempt validation and factors legacy migration).
The existing public metadata inspector suffices; no pin update,
Harbor patch, timeout resolver or control-service change is required.

Regression tests compile each real preset through both native and Workbench
paths with every checked-in harness and two different model values. They compare
the complete compiled configuration against the old preset, preserving selected
agent identity, model, kwargs, environment and other phase settings while proving
the native timing fragment survives. Separate checks preserve the default and
exact held-50 membership, including both QEMU tasks.

## Published source and image provenance

- Fork: <https://github.com/evalstate/terminal-bench-2-1/tree/qemu-fixed>
- Immutable source:
  <https://github.com/evalstate/terminal-bench-2-1/commit/75f5a2e66b2dfd9d7eba3065a9d919c1f9da5c5e>
- Original baseline: `d49e28f1e4ddd13d289e85a5f312a66750951932`.
- Reviewed dependency repair: `46d924fcdf822f0dfdf6848ca660f5eaede89ae1`.
- `qemu-startup`:
  `ghcr.io/evalstate/harbor-hf-trial-worker@sha256:8538e610ab607e87f69fa5b877dce84c989a824c3745d560281a42ad787ecb85`
- `qemu-alpine-ssh`:
  `ghcr.io/evalstate/harbor-hf-trial-worker@sha256:01196285a6e6dd4ed363a08eaa2f6a8a460c5eaed056652ce264649dc2a38ef1`

Anonymous reads verified each exact index, linux/amd64 manifest and config by
SHA256. Both indexes select runtime manifest
`sha256:1bb5e5b544ccaa91c216095ada0a3f8bad989ae66cfb6f0cc016de33ec3d262b`
and config
`sha256:cda04df865dfbb77ab37f6377266d20f747df472b243131e3240e3ede2ff9a92`.
Different attestations explain different index digests. Attestations identify the
original checkout, not the subsequent repair commit. No complete anonymous layer
pull was performed for this publication.

The reviewed Dockerfiles use mutable `debian:bookworm-slim` and explicit
`netcat-openbsd`. The execution image references are immutable; a future rebuild
of that mutable source base is not claimed to reproduce these images.

Retained earlier native Harbor reference-solution evidence records one successful
unchanged verifier per task (reward 1 each, no retries or exceptions, kernel
assertions passed). Those images were not rebuilt and those validations were not
repeated during publication. There was no model test.

## Native contract and metadata-only verification

Harbor owns resolution. Checked the current integration pin
`dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e` in:

- `src/harbor/models/job/config.py`: `DatasetConfig`, `JobConfig` and attempts.
- `src/harbor/registry/client/git_repo.py`: immutable repo syntax, implicit
  dataset path and native sorted task membership.
- `src/harbor/job_plan.py`: public planning, caching and native trial expansion.
- `src/harbor/models/job/lock.py` and `src/harbor/models/task/task.py`: task
  fingerprints and native task environment configuration.

Reviewed upstream history through `191d1b98`; `9a2e3b13` adds CLI metadata-only
validation/dry runs. This change does not reimplement that feature or require a
runtime pin change: the existing pinned metadata inspector already uses native
`JobPlan` APIs. No `harbor run` command, Job construction or task execution was
used. No new product parser, generator, runtime branch or Harbor patch was added.

The native Git dataset fragment is `repo: https://github.com/...git@<full-commit>`
with `path: tasks`. Do not add `name`: at this pin, `name` selects a named registry
dataset and cannot be combined with the implicit `path`. The fork needs no
registry conversion or additional dataset manifest.

The existing `harbor_hf_agents.launch` metadata CLI, using the exact installed
Harbor pin and an isolated credential-free environment, fetched the public source
and returned 89/89, 89/445 and 2/4 task/trial counts. One reviewed agent configuration
was supplied only for metadata expansion; nothing was installed or invoked.
These counts are not an executed job lock, verifier result or model smoke result.

A separate native metadata comparison of baseline and published source confirmed:

- identical ordered membership of 89 tasks;
- exactly two effective image changes and two changed native task fingerprints;
- all 87 other task fingerprints and Git content unchanged;
- only the two task Dockerfiles, README provenance and task image references
  differ; instructions, guest ISO, kernel checks, reference solutions and scoring
  tests remain unchanged.

Native repaired task fingerprints:

- `qemu-startup`:
  `sha256:5a7beeb4ad3dce5f088c535e1968e22f123a15d7caf763f6ebf340b88498925d`
- `qemu-alpine-ssh`:
  `sha256:2e5bb225b5c7ffba5c6f99cec8ba5ec8f8c3ab50cf23f387afb1432a14ef9fe3`

SHA256 of compact, sorted-key JSON of the ordered native task paths:
`sha256:2b9f97f021271ccd69d895e9fb31a4fc25c7b09c053422edb1cd219cd1eccb5a`.
SHA256 of the corresponding short-name-to-native-fingerprint map:
`sha256:ad10807b05f223fc4af44de8360f1aeb073e67902017e48ae4914b827d54c291`.
These are comparison receipts, not a new runtime contract or execution lock.

## Inventory and retention

The independently indexed project authorization permits this one public Git fork
because canonical benchmark write access is unavailable and native Harbor needs
published task definitions. The canonical control Space and artifact Bucket are
unchanged, and the existing GHCR package is retained. No new service, package,
paid compute, deployment or recurring resource was created. Retain the pinned
source and images until upstream repair **and** historical retention requirements
are satisfied; deletion requires explicit approval. No upstream issue or PR was
opened.

## Repository validation

- Node 22.22.0: formatting, lint, typecheck, build, generated-contract checks
  and dependency audit passed; 1,063 unit tests and 64 browser tests passed.
  Four new preset regressions cover native schemas, immutable source, diagnostic
  eligibility, preserved full settings and the exact two-by-two smoke.
- The initial browser invocation reused an existing default-port server and was
  stopped after failures. The clean, isolated-port run with reuse disabled passed
  all 64 tests. No existing server or unrelated worktree was modified.
- Normal Slophammer and DRY checks passed. Baseline mode remains unavailable
  because `slophammer-baseline.json` is absent; the requested mutation command
  remains unavailable because `scripts/check_mutation.py` is absent. Neither
  gate was weakened. No product Python, worker, Dockerfile or runtime code changed
  in Harbor-HF, so Python coverage and image builds were not repeated.
- Public privacy checks and complete source/preset/metadata review passed using
  only the explicitly approved fork and image identifiers. Detailed native
  inspection and anonymous registry receipts remain in private evidence.

## Exact held-50 selection

`presets/benchmarks/terminal-bench-2-1-held-50-1-trial-qemu-fixed.json`
contains the explicit native `DatasetConfig.task_names` selection. It is the
50-distinct-task union of the historical basic-48 and upgrade-2 selections,
cross-checked against the held-50 list and both historical partitioned
configurations. Both QEMU tasks belong to basic-48. It is **not** the first 50
of the 89-task dataset or a new canonical benchmark release.

This preset preserves the task set and one native attempt, not historical job
execution equivalence. It uses the current full HF preset defaults: concurrency
8, `cpu-upgrade` for all tasks, agent timeout multiplier 4 and setup multiplier
2, with explicit zero retries. Historical basic-48 used `cpu-basic` with
concurrency 5 or 7; upgrade-2 used `cpu-upgrade` with concurrency 1. Their
six-hour agent override and provider configuration are not copied. Harbor
retains ownership of task resource metadata and sorted native resolution order;
this is not the original two-job submission order.

The source and image pins above are unchanged. Only task selection is added;
no control logic, benchmark parser, agent special case or runtime patch is needed.
Rechecked the pinned Harbor `models/job/config.py` and
`registry/client/git_repo.py` and upstream history through `191d1b98`:
native explicit selection already exists, so no pin update is required.

Held-50 validation: the existing pinned native metadata CLI resolved **50 tasks,
one agent and 50 trials** in a credential-free environment. Exact preset
membership matches the historical union; every selected task exists at the pin.
Git content comparison against the baseline found all 48 non-QEMU task trees
unchanged and exactly the two previously published effective QEMU image changes.
No task, container or model was executed. Private source-file hashes and native
inspection receipts are retained outside this repository.

The amendment passed 1,064 unit tests and 64 isolated browser tests, formatting,
lint, types, build, generated-contract checks, dependency audit and normal
Slophammer/DRY. Baseline and mutation commands were retried and remain unavailable
for the missing files described above. No checks were weakened.

## Six-hour suite validation

Pinned native metadata inspection resolved 89/89, 89/445 and 50/150 task/trial
counts. A separate credential-free public `JobPlan` inspection of all six actual
compiler outputs (three presets, two paths) confirmed the override, null cap and
multiplier on **every** expanded native trial, matching task membership and image
pins. These are metadata plans, not executed locks or measured runtime evidence.
The direct-config metadata CLI admits catalog agents, not Workbench command
agents; Workbench outputs were checked with native public planning instead.
No agent was instantiated or installed, and no task/container/model was run.

- All eight pre-existing benchmark preset files remain byte-identical.
- 1,140 TypeScript unit tests passed, including 76 new suite regressions;
  64 isolated browser tests passed with the repository-pinned Node 22.22.0.
  An initial browser invocation was stopped before test output and rerun cleanly.
- Formatting, lint, both type checks, build, generated checks and npm audit passed.
  Existing lint warnings remain; the new test file adds none.
- Ruff, Python formatting, ty and 100 CLI tests passed with 89.10% coverage;
  Python dependency audit and normal Slophammer/DRY checks passed.
- Supplemental TypeScript coverage is 82.32% lines / 74.77% branches, below 85%.
  Baseline and mutation commands remain blocked by the previously documented
  missing files. No threshold, line budget or check was weakened.
- No runtime source, generated contract, worker, image or deployment changed.
  Image builds and remote execution were not repeated for this preset-only work.
