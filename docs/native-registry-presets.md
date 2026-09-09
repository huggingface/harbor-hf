# Native registry benchmark presets

Reviewed benchmark presets accept two mutually exclusive native Harbor dataset
forms in `job.datasets`:

- Existing Git datasets: `repo` (HTTPS) and `path`. Their v1 validation and
  serialized representation are unchanged.
- Registry package datasets: `name` (`org/name`) and `ref` (an immutable
  lowercase `sha256:` digest). Mutable tags, bare legacy registry names, mixed
  Git/package fields, custom registry locations and unknown fields are rejected.

Both forms retain native `task_names`, `exclude_task_names` and `n_tasks`.
These are configuration, not resolved task lists: Harbor applies the filters,
including glob semantics and limits. Harbor also expands tasks, agents and
`n_attempts` into trials. No task-count or source-type field is added.

## Harbor-first evidence

Checked at pinned revision `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`:

- `src/harbor/models/job/config.py`: `DatasetConfig`, source validation,
  package versus Git dispatch, filtering and native `JobConfig.n_attempts`.
  Names containing `/` with no `repo` use package resolution and preserve `ref`.
  Bare legacy registry names take a different path that does not use that ref.
- `src/harbor/models/package/reference.py`,
  `src/harbor/models/package/version_ref.py` and `src/harbor/constants.py`:
  native package-name constraints and digest references. Preset validation
  additionally rejects trailing whitespace and requires full immutable digests.
- `src/harbor/registry/client/package.py`: Harbor resolves the dataset version,
  derives pinned task package references and handles inaccessible task versions.
- `src/harbor/job.py`: dataset resolution and task × agent × attempt expansion.

Read public upstream history through
`7d5285b4` on 2026-09-09, including the dataset/config/registry changes since the
pin. `9a2e3b13` adds native config validation and metadata-only dry runs;
`c29f416a` avoids repeated Hub resolution for cached pinned tasks. Neither is
needed to represent registry presets: that behavior is already in the pin.
No newer Harbor behavior is reimplemented and the pin remains unchanged.

## Ownership and implementation

The gap was Harbor-HF's Git-only reviewed-preset admission schema, not Harbor
resolution. `packages/contracts/schemas/benchmark-preset-v1.schema.json` remains
authoritative. Generated TypeScript exposes a dataset union; the existing Ajv
validator compiles the extended schema. Run the normal generator for contracts,
OpenAPI and browser clients; unchanged generated outputs need no manual edits.

`PresetCatalog.buildJobConfig` and `buildWorkbenchJobConfig` already clone the
native benchmark job fragment. They require no new branching or translation.
The existing Overview and Workbench selectors use preset identity and native
concurrency, not dataset source fields, so no new UI control is necessary.
No parser, resolver, migration reader, persisted alias or upstream patch is added.

Synthetic tests exercise two unrelated registry package names and the prior Git
form through both compilers, preserving all native selectors and attempts.
Browser coverage verifies the same three forms in the existing Workbench
selector. Existing browser tests retain Overview and Workbench launch coverage.

## Limits

Offline schema/config validation does not prove that a registry version exists,
that every requested task matches, or that task packages are accessible. Only
Harbor resolution can establish that. Preparing a preset is not authorization
to resolve remotely, launch, infer, publish or move credentials.

The current reviewed preset has one native job-level environment. A historical
multi-hardware partition is not reproduced by adding registry support. Keep
resource choices explicit at launch review; do not introduce per-name hardware
branches or a second scheduler. Exact private selections and provenance belong
outside this public repository.

## Local verification (2026-09-09)

Passed formatting, lint, TypeScript checks, 937 unit tests, build, dependency
audit and 61 synthetic browser tests. Both Dockerfiles build for `linux/amd64`.
Python Ruff, formatting, ty and dependency audit pass; 46 CLI tests reach 87.98%
coverage, and agent-package Ruff, ty and all 155 tests pass. Agent checks require
building the existing reviewed SDK backport wheel first.

Generation is byte-stable. `check:generated` also passes against a temporary
index containing the candidate generated outputs, without staging the actual
worktree. Against the unchanged real index it reports the intentional generated
type diff. OpenAPI and browser client outputs remain unchanged.

Known repository check gaps remain: supplemental global TypeScript coverage is
81.69% lines, 81.49% functions, 79.68% statements and 74.12% branches, below 85%.
The requested Slophammer baseline file and mutation-check script are absent;
normal Slophammer DRY and public-privacy checks pass. No threshold was lowered.
Browser verification uses an isolated artifact directory; an earlier run failed
on a missing Playwright trace artifact, not an application assertion.
