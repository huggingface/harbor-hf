# Local-evidence combined-result browsing

## Ownership and native review

The earlier [transport optimization](2026-09-23-combined-result-responsiveness.md)
was deployed but did not resolve hosted latency. Even a warm request redownloaded
native results and receipts and fetched the complete HF Job inventory before
consulting the native aggregate cache. This change removes that request-path work,
not the browser deadline or execution safety checks.

Harbor-HF owns its disposable projection and HTTP display cache. Harbor owns all
native results, selection semantics and aggregation. Reviewed Harbor revision
`dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`:

- `src/harbor/job.py`: native result writing uses `exclude_trial_results=True`,
  including finalization; the root aggregate alone cannot replace trial evidence.
- `src/harbor/job_plan.py`: public `JobPlan.aggregate` and `aggregate_stats` remain
  the aggregation authority; checked planning/result history, including JobPlan
  extraction and subsequent planning changes.
- `src/harbor/models/job/result.py`: `JobResult.trial_results` and native statistics.
- Existing `harbor_hf_agents/replacements.py`: unchanged native provenance,
  multiplicity, ancestry and complete-coverage validation followed by aggregation.

There is no general Harbor gap, alternative metric engine, native field alias,
new durable record, SQL column/table, resource or API version. The only new response
field, nullable `observed_at`, is Harbor-HF's existing full-projection observation
clock, not Harbor execution time or a persisted completion assertion.

## Data path

A successful projection rebuild already reads complete native trial JSON into the
existing `trials` table and validates attempt-cost receipts. Retain those parsed
receipts in disposable process memory and retain only the provider identities of
native config/lock files. Full rebuilds replace that memory; scoped rebuilds
replace only their run. No trajectory or log inventory is retained for browsing.
Nothing is written back to the Bucket.

A cold view captures the projected record graph, native results/trials, receipts,
state and relevant observed Jobs synchronously. It reads only config and lock
files, fencing them against projected provider identities with shallow job-root
listings. It passes the same full native bundle shape to the unchanged Harbor
bridge. Existing authoritative attempt-cost reconciliation still preserves unknown
costs and rejects duplicate identities; this is reported spend, not billing.

The bounded, eight-entry/32-MiB native display cache is checked before any remote
I/O. Its content key covers source/ancestor/descendant records, native results and
trials, receipts, state, config/lock identities and related observed Jobs. An
unchanged rebuild can reuse the native aggregate while reporting the newer full
observation time. Warm reads need no Bucket reads/listings, provider Jobs requests
or native aggregation. Overlapping cold requests for identical evidence coalesce.

Changed evidence invalidates the key. Evidence changing during an awaited
inspection produces HTTP 409 instead of publishing the older result. Failed native
or cost inspections are not cached. A failed projection refresh invalidates the
observation until a successful full rebuild; reopening SQLite without that rebuild
cannot expose a cached aggregate. Missing metadata and inconsistent evidence stay
unavailable. Observed active sources stay pending. There is no original-score
fallback, favorable-outcome selection or hidden refresh of evidence age.

## Freshness and execution boundary

The console labels the server observation timestamp as a projection snapshot,
explicitly not a live execution safety check. A successful HTTP request is not a
new Bucket or Jobs observation. Unobserved remote changes become visible through
normal reconciliation; historical display must not authorize execution.

Replacement validation/submission and other execution mutations retain the fresh
`completedSource` and `ReplacementEvidence` paths, including provider inventory,
recorded-parent inspection, native bytes and review fingerprint checks. Parent
preflight is unchanged. Cached display output is never an execution input.

## Validation evidence

Regression tests exercise the actual `ControlService.replacements` path with
provider access prohibited. A synthetic cohort of 512 original trials and one
replacement, each with a receipt, needs four cold file reads and two shallow root
listings; warm reads need zero remote operations and reuse one native aggregate.
The native aggregation boundary is a test stand-in in this I/O test: these counts
are not a hosted timing measurement or proof of a benchmark score.

Other tests compare projected native bundles with the strict fresh reader; cover
unchanged/changed/deleted evidence, recursive graph changes during inspection,
failed rebuilds, reopening SQLite, scoped metadata retention, receipt consistency,
live Job observations, uncached failures, response isolation and cache limits.
Fresh execution validation still rejects newly live Jobs despite a cached view.
Browser fixtures require the observation field and test its truthful label.

The cross-language agent test fixture is updated for the required response field;
`.dockerignore` excludes that test directory from both image contexts. Agent runtime,
lockfile and Docker inputs remain unchanged, so existing worker images are retained.

Local release validation passes: 1,682 Node tests; full coverage at
91.09% lines, 85.11% branches, 88.18% functions and 89.43%
statements; 77 browser tests; root Python 102 tests at 89.10%; and 598 agent tests.
Format, lint, types, builds, dependency audits, Slophammer and both linux/amd64
Docker builds pass. Browser geometry caught an unnecessary snapshot label on
original-only panels; show that label only with combined results instead of
weakening layout assertions. No thresholds or coverage scope were reduced.

Hosted measurements must be recorded after deployment. No hosted responsiveness
improvement is claimed from the synthetic I/O regression alone.
