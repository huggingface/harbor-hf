# Operator-reviewed replacement backend

This document describes the approved replacement workflow. Project release
authorization is recorded separately. It does not itself authorize a paid
replacement launch, credential transfer, or additional resources.

## Native boundary

Checked pinned Harbor `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`:
`job_plan.py` (`resolve_task_configs`, `resolve_metrics`, `aggregate`,
`aggregate_stats`), `models/job/{config,lock,result}.py`,
`models/trial/result.py`, `metrics/{base,mean}.py`, and `utils/pass_at_k.py`.
Available history through `e1be9bd3` was checked alongside the Python bridge's
source/ancestry review. Native `source_jobs` regrading is not operator replacement
authority. The existing approved bridge owns native selection, complete coverage,
provenance and recursive aggregation. TypeScript does not plan replacement tasks,
recompile a Workbench recipe, reconstruct native IDs, or compute Harbor metrics.

The sole durable addition is optional strict `RunRecord.operator_selection`:

```ts
{
  original_run_id: string; // existing run ID
  trial_ids: string[]; // nonempty unique lowercase native UUIDs
  source_fingerprint: string; // native inner fingerprint: sha256:<64 lowercase hex>
}
```

No original artifacts are modified. Native result/status/reconciliation remain
independent of the view-only assembled result. No SQLite table, durable aggregate,
new infrastructure, or execution scheduler is introduced.

## API and UI integration

Generated OpenAPI components now include `ReplacementInput`,
`ReplacementSubmission`, `ReplacementView`, `LaunchValidation`,
`SubmissionResult`, and `TrialIdentity`. Use those generated browser types.
The release-blocker fixes change only frontend fixture literals, not hand-written
UI behavior.

- `POST /api/v1/runs/:run_id/replacements/validate` accepts only
  `{ trial_ids, cost_ceiling_usd }` and returns `LaunchValidation`.
- `POST /api/v1/runs/:run_id/replacements` adds required `fingerprint` to that
  body and requires the normal `Idempotency-Key`; returns `SubmissionResult`
  with HTTP 201 for a new immutable run and 200 for an exact retry.
- `GET /api/v1/runs/:run_id/replacements` returns `ReplacementView`:

```ts
{
  run_id: string;
  operator_selection: NonNullable<RunRecord["operator_selection"]> | null;
  children: Array<{
    run_id: string;
    status: RunStatus | null;
    operator_selection: NonNullable<RunRecord["operator_selection"]>;
  }>;
  assembly: {
    availability: "none" | "pending" | "available" | "unavailable";
    result: Record<string, unknown> | null; // FULL native JobResult
  };
  incurred: {
    cost_usd: number | null; // known reported subtotal, NOT infrastructure billing
    reported_attempts: number;
    unknown_attempts: number;
    total_attempts: number;
  } | null;
  selected_cost_usd: number | null; // native assembled stats.cost_usd
}
```

The trial-list response now has typed `TrialIdentity.result.id` and the safe
native `exception_info.exception_type` summary. Use `result.id`, not task names,
array indexes, or an invented attempt alias. An exception is evidence for an
operator decision, not an automatic infrastructure classification. Disable IDs
already present in direct children's `operator_selection.trial_ids`. Replacing a
replacement uses that child's native run page and its own native IDs, never an
assembled synthetic attempt list.

Keep selection and ceiling unchanged between review and submit. The public
review fingerprint binds the native source fingerprint, canonical UUID selection,
and ceiling. Only the native inner fingerprint (`sha256:` plus 64 lowercase hex digits) is
stored in `operator_selection`. The public review hash remains bare 64-character
hex and is not interchangeable with that source identity. This unpublished
feature keeps immutable schema version `v1`: bare source hashes are rejected by
the native response validator, durable RunRecord schema and API view schema;
there is no compatibility reader, migration, normalization or fallback.
Exact retries use the same key, body and fingerprint; they repair missing state
through normal persistence before overlap/source-revalidation checks. Different
keys may select disjoint batches but not overlapping targets. Both POST routes
reuse operator authorization, CSRF, write-mode and inference-binding defenses.

## Evidence, costs and caching

The server freshly reads immutable records and native config/lock/job-result and
shallow per-trial result JSON. Source directories lacking a native terminal result
are rejected. Native Python reviews the full source evidence and immutable ancestor
chain; the browser cannot supply either. Native review derives the prospective
owned target config. The shared subprocess busy gate has 32 MiB stdin/stdout
bounds and uses only the existing configured control token for source inspection.

The source run must be complete under normal lifecycle/cost policy and have no
live owned Jobs; recorded parents are inspected when their absence is uncertain.
All observations are read-only. Incidental provider read failures do not authorize
execution or produce a zero cost.

Assemblies are bounded to eight cached results and 32 MiB total, keyed by fresh
source object content identities and relationship records. Each read checks source
membership and completion before considering cached native output. Missing or
changed evidence never falls back to the original cohort. Cache removal or a
projection rebuild loses no relationship authority.

Incurred cost uses the existing native attempt-receipt deduplication and coverage
helper across original and all descendants, including replaced-away and retried
attempts. A null subtotal means no reported costs; a null coverage object means
coverage could not be established. Counts describe observed terminal native results/receipts,
not future/planned or still-running attempts. Unknown reported agent cost remains unknown; this
is not infrastructure billing. Subset runs do not inherit full original pricing
estimates. Assembly does not invent a new shared pricing estimate.

## Leaderboard behavior and remaining representation gap

Fresh immutable relationships withhold pending/unavailable roots and exclude every
subset run, including when a projection is awaiting repair. Available cohorts use
Harbor's chosen results, original metadata and repeat count. The native scalar
mean includes unsuccessful chosen trials in its denominator; no reward-based
replacement fallback or error-free requirement is applied. Native cost is separate
from all-incurred reported cost. No aggregate is written into execution state.

**Remaining gap:** the existing public leaderboard has one scalar `pass_rate`.
An assembled native result is eligible only with exactly one eval, exactly one
metric object, and exactly one key `mean` with a finite numeric value. Multiple
metric entries, extra keys, custom metrics and multiple eval groups are withheld.
Harbor `metrics.base.aggregate_reward_dicts` returns reward-keyed dimensions for
multi-reward inputs: native `Mean().compute([{"mean": 0.9, "accuracy": 0.1}])`
returns those same two keys, not an overall mean. Such results are withheld from the scalar
leaderboard, although its full native result remains available in the replacement
view. The backend does not invent a reduction or metric mapping. Extending that
public representation requires a separately reviewed contract decision. This does
not block admitting or executing such configurations.

Offline TypeScript unit tests use a fake native port/subprocess for control
boundary, bounds, concurrency, persistence and relationship checks. An additional
Python-driven cross-language gate uses real `replacements.review` output and
`Evidence.fingerprint`, passes that exact JSON through compiled TypeScript
`NativeLaunch.replacementReview`, validates and creates/re-reads an immutable
RunRecord in `FilesystemObjectStore`, then passes the unchanged stored identity
back into Python child ancestry and parent preflight. It covers public tasks and
private Dataset ancestry with normalized native defaults and repeated tasks.
Only external registry metadata, task caching and inspector transport are mocked;
native planning, hashing, derivation and validation are real. Bare source hashes
are rejected at transport/schema/ancestry/preflight boundaries; immutable retries
retain the original string. No Python production fingerprint representation changes.

The gate lives in agent pytest because CI builds Node before creating the agent
venv. It requires the compiled workspaces and does not silently skip when missing.
The TS metric fixture is generated by pinned Harbor `Mean.compute` and verified
against it in agent pytest. Both multi-reward output with a `mean` reward key and
multiple metric entries are tested, without discarding failed selected evidence.
These offline gates do not certify live private-source integration.

## Local validation (release-blocker fixes)

- Node 22.22.0: formatting, lint, typecheck and build passed; lint retains warnings.
- Full TypeScript unit suite: 1,523 passed; focused backend/API/native-transport/UI
  tests: 149 passed. Full-suite coverage for leaderboard and replacement modules:
  97.29% lines, 90.64% branches, 98.27% functions. Each exceeds 85% line coverage.
  Running only replacement tests does not cover the old leaderboard branches;
  the coverage gate uses the full suite rather than lowering the threshold.
- Browser suite: 75 passed on an isolated port with four workers. The initial
  default-port invocation stalled; the first isolated ten-worker run had one
  existing refresh-disclosure visibility failure (74 passed). That test and the
  replacement flow passed in a three-test focused retry before the full rerun.
  No UI behavior or loading tests were changed to obtain the pass.
- Agent-package Ruff, format and ty passed; all 394 Python tests passed, including
  the public/private cross-language gate and native Mean fixture verification.
  Focused replacement tests: 73 passed. Python production code was not changed
  for these two fixes.
- Root Ruff, format, ty and 102 Python tests passed; coverage is 89.10%.
  Root and npm dependency audits passed (zero vulnerabilities). Public privacy
  and diff checks passed.
- Generated artifacts are reproducible by repeated content-hash comparison.
  `check:generated` reports the intended uncommitted generated diff against HEAD;
  no staging or commit was performed to hide or bypass that gate.
- Slophammer DRY passed; the required baseline check remains blocked by the
  missing `slophammer-baseline.json`.
- Both local `linux/amd64` Docker builds were attempted with networking disabled;
  package installation failed without network access. Images were not published.
- No benchmark run controls, paid execution, inference, deployment or live-source
  integration were performed. The first private test exposed a missing registry
  metadata stub and attempted a synthetic repository lookup; the corrected gate
  mocks that external metadata and explicitly forbids Git invocation.
- The scalar leaderboard representation gap above remains intentionally open:
  ambiguous results remain available in the native replacement view.

## Run-page workflow

The Infrastructure replacements panel loads on demand and separates Original,
Replacements, and Combined views. Operators select exact native errored trial
IDs, explicitly review infrastructure causation, enter a budget, and review the
native effective configuration before submission. A changed selection or budget
invalidates review; stale responses cannot restore it. Already-selected IDs are
not offered again. Replacement failures remain visible and can be reviewed from
that replacement's own native run page.

Submission retries preserve the reviewed body and idempotency key after an
uncertain response, including panel closure. This UI state does not survive page
reload; inspect the linked replacement runs before making a new request. The
server continues to reject overlapping selections from different keys.

Combined metrics and JSON come from the native aggregate. Original execution
state is never replaced by assembly state. All-incurred reported attempt cost
and its unknown coverage are separate from selected-cohort reported cost.

## Temporary integration removal

The separately approved bridge is scoped to Harbor
`dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`. It supplies operator selection,
cross-run provenance and exact coverage validation around native planning and
aggregation. Replace it at the first reviewed Harbor revision providing an
equivalent storage-neutral replacement contract. No removal revision has yet
been identified. Native regrade derivation is not used as a replacement alias.

## Cross-language release checks

Native source fingerprints use `sha256:<64 hex characters>` throughout Python,
transport, durable selection and parent preflight. The public review fingerprint
is a distinct bare hash binding that source fingerprint, selection and budget.
The regression gate exercises real Python output through compiled TypeScript
transport/schema/persistence and back through Python ancestry and preflight.
External source access and inspector transport are mocked; this is not a paid
or live private-source execution test.

Only an unambiguous single-eval, single-metric object containing exactly `mean`
is admitted to the scalar leaderboard. Native multi-reward metrics with a reward
key named `mean` are not mistaken for that scalar metric.
