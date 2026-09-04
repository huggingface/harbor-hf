# Execution-disabled integration

This is a greenfield configuration-authoring integration, not a production-ready
execution service. Writes may save configuration, but cannot admit Runs, reserve
capacity, resolve execution credentials, launch or cancel Jobs, or reconcile Runs.
The API rejects execution with HTTP 503 `execution_disabled` before handlers;
service methods reject direct callers too. Historical records are not migrated.

Workbench stores immutable named native JobConfig fragments under the existing
Bucket, isolated by authenticated owner. New Run previews only configuration,
not resolved tasks, a reproducibility lock, measured cost, or execution approval.
Remote setup and launch controls are disabled. Agent names and options come from
Harbor (`harbor agents list --json`, `harbor agents schema NAME --json`), not a
new local discovery catalog. Reviewed upstream presets remain configuration data.
The old five-profile registry and its publication-dependent submission UI are
not restored. Result-submission reconciliation remains incomplete in this draft.

The [internal CLI contract](2026-09-04-internal-cli-contract.md) records the
subsequent local design review, fresh public-source comparison, threat model,
blocked preparation/ownership contracts, and offline regression evidence. It does
not enable execution or authorize remote operations.

## Reviewed upstream boundary

Harbor revision `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e` was current upstream
main when fetched for this integration; there were no subsequent main commits.
Inspected `src/harbor/cli/agents.py`, `src/harbor/cli/jobs.py`,
`src/harbor/models/job/config.py`, `src/harbor/job.py`, and
`src/harbor/environments/hf_sandbox.py`. Native configuration, discovery,
install-only, task resolution, lock creation, retries, and resume belong to Harbor.

The HF Sandbox environment calls `Sandbox.create` without the required public
ownership-label/namespace integration. Its credential requirement cannot be met
by forwarding the control credential under this repository's boundary. The
removed local code patched a private Hub module and Harbor methods, imported
Harbor execution internals, and removed interrupted trial directories. None of
those workarounds is retained. A future upstream proposal should expose public
Sandbox ownership configuration and a supported CLI/control integration while
leaving resolution, execution, retry, and resume in Harbor. No upstream issue or
PR is authorized or opened here.

HF_TOKEN remains control-only. The existing inference secret is retained in
configuration but unforwarded. Per-user OAuth scopes, billing attribution, and
Jobs/inference delegation require separate verification by the parent research
agent. This branch implements no token forwarding or new OAuth credential store.

No HF deployment, operational API call, Job, inference, resource creation,
credential transfer, reset, migration, or Run action is part of this integration.
