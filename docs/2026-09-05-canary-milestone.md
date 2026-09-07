# Canary-first milestone

Status: local configuration increment only; execution remains disabled.

## Selection and ownership

Use `terminal-bench-2-1` / `two-task-canary`. The historical benchmark profile at
`3510fbe^:profiles/benchmark/terminal-bench-2-1-canary.json` selected
`adaptive-rejection-sampler` and `modernize-scientific-stack` at benchmark revision
`d49e28f1e4ddd13d289e85a5f312a66750951932`. Retain that selection using only
native `datasets[].repo`, `path`, and `task_names`.

This is a new native preset, not restoration of the retired profile reader,
task digest registry, or trial identity format. Start conservatively with
`n_attempts: 1`, `n_concurrent_trials: 1`, and `retry.max_retries: 0`.
The existing HF Sandbox settings are configuration, not proof of runnable
infrastructure or a hard spending limit. In particular, `job_timeout` is an idle
timeout, not a hard wall-clock deadline.

The same preset catalog feeds CLI inspection and the web configuration form.
No new API, persisted field, task parser, scheduler, or result format is needed.

## Harbor source evidence

Checked Harbor pin `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`:

- `src/harbor/models/job/config.py`: public `DatasetConfig` / `JobConfig` own
  task selection, attempts, concurrency, and retries.
- Relevant history includes `163323d3` (config composition) and `ac476798`
  (native built-in agent options). Neither justifies another configuration layer.
- `src/harbor/environments/hf_sandbox.py`: `Sandbox.create` receives image,
  flavor, idle timeout, and forwarding choice, but not caller ownership metadata.
- The existing [CLI review](2026-09-04-internal-cli-contract.md) covers
  `src/harbor/cli/jobs.py`, native configuration preview, and execution boundaries.

All values added by this increment are existing Harbor configuration fields or
existing wrapper preset identity/leaderboard policy. Tests validate the fragment
against the generated pinned schema without resolving tasks or running Harbor.

## Authentication and execution gaps

The shared API already validates bearer identity through HF and applies the
operator ACL. Web OAuth creates an authenticated session with the same role
boundary. Login is not consent to delegate compute billing or move credentials.
CLI OAuth remains unresolved; do not add another identity service or token vault
to work around the managed-client eligibility issue.

The end-to-end milestone is not complete. The supported execution/credential
boundary, public Sandbox ownership and recovery, and lifecycle/cost-stop contracts
remain blockers described in the
[internal CLI contract](2026-09-04-internal-cli-contract.md). Stop execution design
at those gaps rather than reinstating private patches or removing rejection.
No upstream issue, deployment, credential transfer, or launch is part of this
local increment.

After those contracts are resolved and separately approved, demonstrate the
two-task canary through login, native configuration, remote execution, native
results, and proven cleanup before admitting the larger benchmark subset.

## Local verification

- Passed the two new preset regression tests and native
  `JobConfig.model_validate` against the installed pinned Harbor package,
  without task resolution or execution.
- Passed format, lint, typecheck, unit tests, build, generated-file checks,
  npm audit, and both Playwright suites using the repository's Node version.
- Passed agent-package Ruff, ty, and all 32 pytest tests.
- Built both control and CLI-only scaffold images for `linux/amd64`.
- The additional repository-wide coverage check failed the required 85% gate:
  lines 73.05%, functions 68.79%, statements 70.49%, branches 63.53%.
  No production TypeScript code changed in this increment; this result is not
  waived and the increment is not marked release-ready.
- No deployment, credential transfer, inference, or remote benchmark occurred.
