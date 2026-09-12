---
title: Run-recorded inference access review
author: Harbor-HF maintainers
date: 2026-09-11
tags: [inference, authorization, workbench]
---

# Run-recorded inference access review

The run page offers **Review inference access for this run** in Infrastructure
replacements. It uses the immutable `run.json` native `harbor_job_config`, not a
Workbench draft in browser local storage. A name-only `workbench_recipe` is display
provenance, not enough to reconstruct a recipe; no reconstruction is attempted.

A replacement review can fail because the current worker image has no inference
grant even though the original recipe was approved. The run-page review finds an
unambiguous still-enabled, owned approval matching the exact compiled input through
`InferenceBindings.selected`. It changes only that grant's worker image. The model,
route, import path, recipe digest, destination environment, base URL, declared hosts,
source reference and actor remain unchanged. Disabled approvals (including grants
retired by disable/re-enable), missing secrets, foreign owners, changed configuration
and ambiguous scope fail closed. Presence is not provider authentication; declared
hosts are not a firewall guarantee.

If the exact current-image policy is already valid, nothing is saved and no further
credential approval is needed. Otherwise the UI displays the current immutable image
and complete existing scope for explicit confirmation. Approval is an existing
registry policy grant: it applies wherever the exact scope matches, not exclusively
to the source run. It is not blanket trust in future images or other actors. If the
required choice cannot be recovered unambiguously, ask the original binding owner to
inspect Manage secrets; do not recreate a recipe or substitute another source to
bypass the decision.

## API and race boundaries

`POST /api/v1/runs/:run_id/inference-review` accepts only an empty object and no query
parameters. It loads the original record server-side and validates it against the
pinned native JobConfig schema. It checks run identity, submitted actor and Harbor
revision. No browser-supplied configuration, source override or worker image is
accepted. The response is a transient policy review, not a second recipe format.

Confirmation uses the existing `POST /api/v1/inference-bindings/:ref/approve` API,
registry audit history and store. Both endpoints require operator authorization,
CSRF for browser sessions and enabled writes. Reviews are owner-, registry-revision-,
run-record-digest-, current-image- and expiry-bound in the existing bounded in-memory
review cache. Save freshly reloads the immutable run and registry and checks presence
again. Restart loses reviews. Failed/uncertain saves require fresh review, not an
automatic retry. Browser run/authority changes discard stale responses; the server
remains authoritative across tabs and deployment changes.

No credential value is read or moved by review. There are no new durable fields,
resources, run state, SQLite tables, source stores or execution paths. The original
Workbench recipe review remains unchanged. Approval never submits a replacement or
starts a Job. Return to Original and perform normal selection/budget review and
explicit submission; all ordinary admission and execution checks still apply.
An empty Replacements tab means no related run exists, not that approval succeeded.

## Ownership and native evidence

Checked Harbor `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`:

- `src/harbor/models/job/config.py`: public `JobConfig`, native agents and validation.
- `src/harbor/models/trial/config.py`: public `AgentConfig`, `kwargs`, `env`,
  `import_path`, `model_name`, `extra_allowed_hosts`, setup timeout and native
  environment serialization.
- Relevant available history for those paths, including `283ef4ee`, `f633b8a8`,
  `abeae607`, `71180a2e`, and `4861de0b`, plus later available path history. These
  native fields already carry execution input; there is no native HF registry
  approval mechanism to duplicate.

Harbor owns configuration and execution. Harbor-HF owns authenticated credential
policy and the console. Existing `InferenceBindings.selected` already accepts
compiled native input and remains the only grant matcher. The review never calls
`compileAgentWorkbenchRecipe` on run input and does not add another digest algorithm
or reverse compiler. API scope values are the existing registry grant fields;
`run_id` references the existing run. No changed persisted field mirrors Harbor.
This is control policy work, not a temporary missing-Harbor execution adapter.

This document describes local implementation, not deployment, live grant approval,
credential movement or paid-run authorization.
