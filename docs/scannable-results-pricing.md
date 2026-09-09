# Scannable summaries and pricing scenarios

Runs remains a sortable list. Summary numbers are display projections only:
score to three decimals, tokens in millions, and `-` for unavailable values.
Positive token counts below 1,000 display `<0.001M`, while known zero displays
`0.000M`. Nonfinite formatter inputs remain unavailable.
Hover or focus a numeric value to read its exact accessible label; column
accessors retain raw numbers, not rounded strings. Input includes cache; cache
is a subset of input, not additional input. Completion includes errored trials.
The progress component receives percent (89/89 is 100), not a fraction.

A score is shown only for one evaluation with one unambiguous native `mean`.
The single reward key labels it when available. Multiple evaluations or metrics
are not averaged into a purported authoritative score. Native evidence remains
unchanged and accessible in existing detail views.

## Exception display boundary

Exact recorded types are grouped for display only:

- Environment / transport: `EnvironmentStartTimeoutError`,
  `GKEExecStreamClosedError`, `NetworkConnectionError`.
- Provider failure: `ApiInternalServerError`, `ApiOverloadedError`,
  `ApiConnectionClosedError`, `ApiResponseStalledError`.
- Rate limit: `ApiRateLimitError` (separate from infrastructure-related counts).
- Verifier exception: `VerifierTimeoutError`, `AddTestsDirError`,
  `VerifierOutputParseError`, `DownloadVerifierDirError`,
  `RewardFileNotFoundError`, `RewardFileEmptyError`.
- All other types remain unclassified.

Infrastructure-related counts are the union of environment/transport and provider
failure trial identities, not inferred infrastructure root causes. A trial can
appear in multiple categories; affected and infrastructure-related totals are
individually deduplicated. Partial evidence retains positive lower-bound counts; a zero count with partial
evidence displays `-`, not `≥0`. Explicitly complete empty evidence displays zero. Zero
reward is not an exception. Existing exact-type groups and trial links from
PR #193 remain available. No message, log, trajectory, or task-name classifier is
introduced; scoring validity and retry eligibility remain unknown.

## Pricing boundary

The expandable detail panel accepts explicit uniform USD-per-million rates for
input, output, and cached input, plus a separate long-context rate set. These
rates apply uniformly across all configured model routes in each hypothetical
scenario; provider prices are never inferred. Unsaved new-scenario drafts survive
polling and tab navigation but are previews only. Explicitly saved preferences
survive reload in browser-local storage. Neither drafts nor saved preferences
enter JobConfig, API records, native costs, or execution policy.

For each scenario:

```text
USD = ((input - cached) * inputRate + cached * cacheRate + output * outputRate) / 1e6
```

All usage and rate fields must be present. Zero is valid; missing is not zero.
Usage must be a nonnegative safe integer with cache no greater than input. Rates
must be finite, nonnegative, and no greater than 1,000,000 USD/M (a display-input
sanity bound, not a provider policy). Estimates describe reported usage only;
native aggregates can be partial and are not billing totals.

The editable threshold defaults to request input **greater than 272,000 tokens**,
including cache. Harbor does not expose the required per-request tier usage in
these native result aggregates. Consequently actual tier-adjusted estimate is
always `-`, with an explanation. All-standard and all-long-context values are
explicit scenarios, not bounds or automatically selected tiers. Changing the
threshold cannot apply a premium to cumulative run or trial usage.

## Harbor review and upstream gap

Reviewed at `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`:

- `src/harbor/models/agent/context.py`: input includes cache.
- `src/harbor/models/trial/result.py`: native context totals preserve null and
  aggregate available step fields independently.
- `src/harbor/models/job/result.py`: aggregate usage, metrics, exception identities,
  and progress; no request-tier usage.
- `src/harbor/agents/installed/base.py`: exact provider/transport exception types.
- `src/harbor/trial/errors.py`, `src/harbor/environments/gke.py`, and
  `src/harbor/verifier/verifier.py`: exact environment and verifier types.
- `src/harbor/metrics/mean.py` and `src/harbor/metrics/base.py`: native mean shape.

Reviewed history since that pin through `1f84b4c0`; no native request-tier support
has landed. No pin update or local Harbor patch is needed for these display
changes. A future upstream change would expose structured per-request inclusive
input/cache/output usage with model-route identity and completeness, or equivalent
native tier subtotals. Harbor must own that evidence extraction; Harbor-HF must
not reconstruct it from trajectories. No upstream publication is performed.

## Component handoff

`run-summary.ts`, `pricing.ts`, and `exception-categories.ts` provide pure display
helpers. `run-summary-cards.tsx` exports `ScoreValue`, `TokenValue`, `CostValue`,
`ExactValue`, and `RunSummaryCards`; `pricing-panel.tsx` owns browser-only edits.
The matrix uses native trial identities and exception evidence without rewriting
outcomes. Runs uses automatic column widths with a minimum diagnostics width;
its table scrolls rather than squeezing diagnostics into single-word lines.

## Local browser verification

Playwright uses synthetic API responses only. Coverage includes exact score
hover/focus text, million tokens, zero versus missing values, 89/89 progress,
raw-number list sorting despite identical rounded labels, inclusive-cache
pricing, missing/invalid/zero rates and usage, polling and navigation retention,
and no API mutations from pricing edits. Changing the request threshold cannot
select a scenario from cumulative usage.

Desktop (1440px) and mobile (390px) screenshots are generated under the ignored
`apps/control-web/test-results/` directory: summary, matrix, expanded pricing,
and Runs list. The matrix fixture has 89 tasks × 5 repeats, successful trials,
zero rewards, and 15 exact native provider exceptions. Its supplied native score
is displayed, never recalculated. A separate 89-trial fixture checks 100% progress.
The 24px targets remain unchanged: desktop shows approximately 38 task columns
at once, with horizontal scrolling to all 89 and five complete repetition rows.

Local verification: 649 unit tests and 34 Playwright tests pass. Root formatting,
lint, TypeScript checks (including Space types), build, generated contracts,
dependency audit, and public-privacy checks pass. The summary, pricing,
diagnostics, exception-category, and matrix files have 100% line coverage;
their branch coverage is at least 88.88%.

Validation limitations: the required `slophammer-baseline.json` and
`scripts/check_mutation.py` are absent, so those checks cannot complete.
Normal Slophammer and DRY checks pass. Global TypeScript coverage is 79.53% lines,
77.12% statements, 77.62% functions, and 70.69% branches (below the 85% gates);
no thresholds are lowered. Python source is unchanged. Local verification
performed no deployment, credential access, or remote mutation.

## Measured agent time and stable polling

Trial tooltips show one `Agent time` line. `Agent Σ` on run status sums recorded
`TrialResult.agent_execution.started_at/finished_at` intervals, or the populated
`step_results[*].agent_execution` list instead (never both). These are native
agent-phase wall times, not token throughput, trial environment/teardown time, or
elapsed job time; concurrent trials can make the sum exceed job elapsed time.

Missing, malformed, reversed, and unfinished intervals are unavailable (`−`),
not zero. Valid zero-length intervals remain `0s`. Available step intervals can
form an explicitly partial sum; unfinished multi-step results remain partial.
Coverage shows complete, partial, and unavailable current result counts, not
planned trials or unstarted steps. No live clock estimates are included.

The run response has a generated `AgentTimingV1` display summary, calculated from
current native results during projection rebuild and cached transactionally with
the run row. List and detail reads do not scan trial history. Rebuild/replacement
removes old contributions; archived retries and removed rows are not lifetime usage.
Neither native JobResult nor Bucket records acquire new fields. Overview queries
remain run-only; no additional progress requests, remote scans, or run actions.
Progress responses allowlist only the new agent timestamps and step timestamps;
malformed timing is unavailable without rejecting unrelated trial evidence.

Background polling inserts no refreshing node or periodic live announcement.
A reserved feedback line retains genuine stale/error messages and retry controls.
Positive affected-trial counts are red; zero/missing evidence remains neutral.
Exact typed infrastructure classification is unchanged.

Boundary review: Harbor `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`,
`src/harbor/models/trial/result.py`, `src/harbor/models/job/result.py`,
`src/harbor/trial/single_step.py`, `src/harbor/trial/multi_step.py`,
`src/harbor/trial/trial.py` (`_run_agent_phase`), and `src/harbor/job.py`.
Harbor records the phase intervals and excludes `trial_results` when writing the
job result; JobStats has no agent-duration aggregate. Reviewed the 18 upstream
commits through `1f84b4c0`: no timing aggregate requires a pin update. This is a
read-only presentation of native result files, with no Harbor internal imports,
execution patch, scheduler, or competing lifecycle authority.


## Saved pricing preferences architecture

`browser-pricing-v1.schema.json` is authoritative for the portable browser record;
contract generation supplies its TypeScript type. It is **not** a server durable
record or Bucket object and is not registered in server validation or OpenAPI.
`pricing-store.ts` validates the closed schema with Ajv, additionally rejecting
duplicate IDs and dangling selections. Records contain only schema version,
local scenario IDs/names, six nullable rates, a request threshold, selected ID,
and explicit all-standard/all-long-context tier. No run IDs, routes, models,
account information, or credentials are stored. Limits: 50 scenarios, 80-character
nonblank names, 64-character IDs, 65,536-character serialized reads, rates from
0 through 1,000,000 USD/M, and a nonnegative safe-integer threshold (default 272,000).
Blank rates remain null; zero is valid. Unknown versions/properties, malformed
JSON, invalid numbers, and oversized records are ignored with a visible status.
No migration or automatic repair write occurs; explicit reset permits recovery.

Save & Use atomically applies the draft name and all rates; there is no separate
rename action. New scenario, delete,
selection, explicit tier selection, and clear are browser-only actions, also
available when server writes are disabled. Draft previews never silently update
the selected estimate. Saved selection and tier are shared by Runs and detail
through a lazy, SSR-safe `useSyncExternalStore` adapter with stable snapshots.
Every write is asynchronous and uses the origin-scoped Web Locks API. The operation
re-reads and validates current localStorage inside the exclusive lock; unrelated
scenario edits are preserved even before delayed storage events arrive. Updates
and deletes compare the expected scenario content, and selection rejects changed
or deleted IDs. Stale operations fail visibly rather than resurrecting cleared
preferences. Editors and selectors are disabled while a write is pending.
Storage events notify other tabs and clearing; remount rechecks storage. Browsers
without Web Locks (including unavailable secure-context support) fail explicitly:
there is no unlocked fallback. Serialization applies to cooperating current-version
tabs, not developer tools, browser data clearing, or older clients that ignore the lock.
Content equality detects stale values, not an identical delete/recreate (ABA) cycle;
no revision or durable schema field was added.
Quota/disabled storage errors retain the last successful active preference and
show that the operation was not saved. There are no API calls from this path.

Preferences are scoped to the browser origin, **not an account**. User switches do
not clear them. The UI labels “Saved in this browser”, explains uniform rates
across all displayed runs/routes, and offers Clear saved pricing for shared
browsers. Names must not contain secrets. Clearing removes saved scenario data;
complete unsaved drafts (name, threshold and all rates) otherwise last only for the
loaded tab, keyed separately from saved scenario IDs. They survive route navigation,
not a full reload, and are never written to localStorage. Editor identity no longer
uses serialized saved content. Dirty drafts survive external updates, selection
changes and deletion with explicit conflict feedback and a Reload saved values
(discard/reload) action. Explicit local scenario switching retains per-ID drafts;
New scenario deliberately starts a blank draft.

The always-visible browser-storage note is one line. “About scenario estimates”
contains the uniform-rates, partial-usage, billing/budget, automatic-tier and
shared-browser caveats; run detail no longer tells users to manage pricing in run
detail. Native reported cost and selected scenario estimates remain separate.

The separate **Scenario estimate** column preserves **Reported cost**, agent
timing, and existing run-only polling. `pricing-selection.tsx` builds typed
browser-only rows containing estimates; changing preferences rebuilds these rows
to invalidate table accessor caches without resetting numeric sort state. Missing
values sort last in either direction. No estimate becomes native cost, spend,
a budget, a provider price, or a ceiling. Both views use exactly the same explicit
tier: cumulative usage never activates the long tier. Missing/invalid usage or
rates stays unavailable, and available native aggregates can be partial.

Boundary recheck used pinned Harbor `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`,
`src/harbor/models/agent/context.py` and `src/harbor/models/job/result.py`, plus
locally available history through `1f84b4c0`. Inclusive cache and the absence of
request-tier aggregates remain unchanged. This browser presentation needs no
Harbor patch, execution behavior, or pin update.

Pricing schema validation is now compiled by Ajv standalone during contract
generation and bundled with its Unicode-length helper into static browser ESM;
the store imports that generated validator and its schema-derived type guard,
not the Ajv compiler. Application and preview CSP are unchanged. Regression tests
cover browser startup, pricing save/reload under a response CSP forbidding eval,
Unicode bounds, deterministic regeneration and execution with dynamic code
generation disabled. This is browser-local schema validation, not Harbor behavior;
the pinned `src/harbor/models/job/result.py` boundary remains unchanged.

Validation: 750 root unit/component tests and 42 synthetic browser tests pass.
Browser tests cover save/update/delete, reload, navigation, dirty drafts,
cross-tab conflicts, selected list estimates alongside native cost, and absence
of mutation requests. Store/component tests cover delayed storage events,
concurrent writes, unsupported locking/secure ID generation, and storage failures.

Formatting, lint (six existing shell-template warnings), root/Space types, build,
dependency checks, privacy, normal Slophammer and DRY checks pass. Generated output
is deterministic. Global coverage is 80.30% lines, 78.18% statements, 79.64%
functions and 72.35% branches, below the
unchanged 85% gate. The Slophammer baseline and mutation checks are blocked by
missing baseline and mutation-script files. No gates were lowered. No live API,
credential movement, remote resource mutation or publication is part of this work.
