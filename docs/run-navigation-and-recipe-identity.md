---
title: Runs navigation and recipe identity
date: 2026-09-09
tags: [runs, workbench, provenance]
---

# Runs navigation and recipe identity

New Workbench launches capture optional immutable `run.json.workbench_recipe`
with only `{ "name": "recipe-name" }`. The API derives this name from the
validated, setup-attested recipe; neither submission API accepts independently
supplied display provenance. The snapshot participates in idempotency comparison.
Changing or removing it under the same key is an immutable conflict.

The existing `submission.harness.version` holds the compiled recipe revision.
No second revision, model, reasoning setting, or native execution field is added.
The authoritative run-record JSON Schema generates TypeScript and browser/OpenAPI
contracts. Old records remain valid without a migration or inferred recipe name.
Browser drafts and recipe-library labels are not run identity.

Runs shows the recorded recipe name with the existing revision and a native-agent
tooltip. Without provenance it retains the generic native agent/version identity.
Per-agent configuration detail continues to show native fields directly.

The Run role selector uses exactly `record.role`: All, Diagnostic, or Final.
Final is submission intent, not finished execution. The Role column is separate
from Status. URL parameters `role` and `q` retain selection through reload,
refresh/polling, and browser Back after opening a run. Unknown role parameters
mean All. Search covers run ID, recipe, model/provider, benchmark/preset, native
agent, and revision, case-insensitively. Existing column filters remain available;
there was no existing global filter. Search is applied once before table rendering.
Numeric scenario-cost sorting and measured timing remain unchanged. The overview
makes no new progress requests. New Job and New Workbench run use existing routes.

## Harbor boundary inspection

Inspected the pinned Harbor revision
`dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`:

- `src/harbor/models/job/config.py`: public `JobConfig`, native job identity,
  agents, datasets, and execution configuration.
- `src/harbor/models/trial/config.py`: public `AgentConfig`, native `name`,
  `import_path`, `model_name`, and `kwargs`.

Reviewed history from that pin through `90e28af3`, including changes to those
files. Native validation/dry-run work (`9a2e3b13`) and schema-driven viewer agent
options (`2da50a93`) do not add hosted Workbench recipe display provenance or
Harbor-HF run-role navigation. These refinements are hosted submission metadata
and console presentation, not a Harbor execution gap. No pin change, upstream
patch, execution adapter, resource, or JobConfig change is needed.

## Integration boundary

The shared `app.ts` change is one additional argument to `submitWorkbench`:
`{ name: preview.recipe.name }`. Preserve it when editing reasoning admission.
The service adds an optional final provenance argument, records it, and includes
it in immutable comparison; it does not alter the compiled agent fragment.
No Workbench compiler/runtime, recipe schema, Workbench UI, pricing file, existing
browser test, or timeout-diagnostics implementation is changed here.

Regression coverage includes schema compatibility/validation, API derivation and
spoof rejection, core immutable conflicts, historical native identity, URL/filter
helpers, and the self-contained mocked `e2e/run-navigation.spec.ts`. Browser
fixtures require no credentials, inference, remote resources, or API writes.

## Local validation

- 774 unit tests and 43 mocked browser tests passed; browser checks use the
  dedicated local port 4195, including polling, reload, and browser Back.
- Formatting, lint, TypeScript (including Space), build, dependency audit,
  public-privacy check, Slophammer normal check, and DRY check passed.
- Generated contract files are byte-identical after repeat generation.
  `check:generated` reports the intentional uncommitted schema-generated diff;
  no commit was made to satisfy its Git-clean comparison.
- The global coverage gate remains below 85%: lines 80.31%, statements 78.21%,
  functions 79.57%, branches 72.44%. The new filter helper has 100% coverage.
- Baseline mode cannot run because `slophammer-baseline.json` is missing;
  the mutation gate cannot run because `scripts/check_mutation.py` is missing.
  No gate or threshold was reduced.

All changes and checks are local. No commit, push, pull request, deployment,
credential transfer, resource creation, or live run was performed.
