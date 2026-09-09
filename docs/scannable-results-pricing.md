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
scenario; provider prices are never inferred. Edits survive query polling and
route navigation in the loaded browser tab, but reset on reload. They are not
saved in JobConfig, API records, browser persistent storage, or native costs.

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
