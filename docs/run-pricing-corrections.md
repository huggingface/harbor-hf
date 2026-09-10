---
title: Audited shared run pricing corrections
author: Harbor-HF maintainers
date: 2026-09-09
tags: [architecture, pricing, api]
---

# Audited shared run pricing corrections

Operators can correct shared estimate rates while a run is running or after it
finishes. Correcting an output/cache transposition does not require a rerun.
Original launch rates in immutable `RunRecord.pricing` remain untouched. Reported
Harbor cost, reward, native usage, execution state, cost ceilings, submission
idempotency, and browser-local scenario prices are not changed or reinterpreted.
Historical runs without launch pricing can **Add shared rates (unpriced launch)**;
the original remains explicitly unpriced, not retroactively assigned launch rates.

## Authority and bounded audit

The canonical Bucket stores optional
`runs/<run-id>/pricing-corrections.json`, separately from `run.json`, `state.json`,
archive presentation, receipts and `job/`. The authoritative versioned JSON Schema
is `run-pricing-corrections-v1.schema.json`. It contains a run identity and a bounded
array of revisions (1–1000). Each revision contains a complete USD rate triple,
reason, authenticated actor, server timestamp and server-assigned contiguous
revision number. Existing revision entries are copied unchanged when appending.
The launch-pricing schema owns the reusable rate triple; no JobConfig field or
native result is duplicated. Full-history writes are bounded; reaching 1000 entries
requires separate design review, not history truncation or an automatic reset.
Actor subjects and free-text reasons are private audit data, never public fixtures.

`PATCH /api/v1/runs/:run_id/pricing-corrections` accepts only `pricing`, `reason`
and `expected_revision`. Its authoritative request schema generates TypeScript and
OpenAPI contracts. All three finite rates must be present, between zero and
1,000,000 USD/M; missing is not zero. Reasons must contain non-whitespace text and
are limited to 1000 characters. Audit fields supplied by clients are rejected.
Existing operator authentication, browser CSRF and write-mode checks apply.

Under the existing service per-run lock, the operation:

1. Reads history with the ObjectStore's fresh-read option (bypassing the HF adapter
   content cache without scanning the Bucket).
2. Validates schema, identity, contiguous revisions and extension of known history.
3. Synchronizes validated history into SQL, including on stale intent.
4. Compares the expected revision and returns 409 on conflict, without writing.
5. Appends one audit entry and writes the entire document with the existing `put`.
6. Synchronizes SQL before returning success.

A lost success response is not automatically retried. Repeating the old expected
revision returns 409 after synchronizing the durable state; it cannot append twice.
A failure before or after `put`, or during SQL synchronization, marks correction
availability false and returns a sanitized 503. The next manual attempt must freshly
validate history before proceeding. A committed Bucket write survives SQL failure,
process loss and projection deletion. Invalid or regressed history is never replaced
by a new correction. Returning rates to launch values requires a new audited entry,
not deleting history. Even a same-price submission records the explicit audit reason.

**Single authority limitation:** provider `put` is not conditional CAS. The existing
process-local run lock protects one control process only. Concurrent controllers,
out-of-band writers, deleting history and malicious provider rollback are unsupported.
A cold rebuild can validate the document but cannot prove that an externally deleted
optional document previously existed. This is not a tamper-evident external ledger.
The protocol depends on the canonical provider's atomic object replacement and
read-after-write behavior, as archive does; no distributed-lock claim is made.

## SQL projection and failure semantics

Two additive columns in the existing `runs` table store the validated history and
its ephemeral availability. Old SQLite files start unavailable until rebuilt. No
new table, persistent infrastructure, secondary control authority or per-GET Bucket
scan is introduced. Runs/detail reads retain the existing single SQL query; the
leaderboard consumes those projected views. Rebuild reads only one history object
per run in addition to its existing execution observations.

`PricingProjection` owns these disposable columns. Rebuilds capture a generation
before their first await. The transaction retains any correction/availability
mutation committed since that generation, including null or equal-revision state.
Every successful rebuild fences older overlapping reads; failed transactions do not
advance generations. Before replacing the cache, the candidate must extend existing
history. Read failures preserve last-known history **only for audit display** and
mark it unavailable. A subsequent validated rebuild restores availability.

Shared estimates use the latest validated correction when available, otherwise
immutable launch rates only when history was successfully observed absent. An
unreadable, malformed, identity-mismatched or regressed history yields null estimate
with `correction_history_unavailable`, never a silent launch fallback. This display
failure does not block native execution reconciliation, cancellation or cost stops.
Native reported costs remain available independently.

Run estimates distinguish `launch_rates_reported_usage` from
`corrected_rates_reported_usage`. Leaderboard groups containing corrected or
unavailable histories use `effective_rates_reported_usage`. Partial group subtotals
retain their estimated/total run counts and are not presented as complete charges.
All estimates still use native reported usage, which may itself be partial.

## Browser workflow

The detail page exposes original launch rates and the complete private audit history
to authenticated readers. Only operators with writes enabled can open the editor.
The form separates input/output/cached rates, requires a reason, displays the proposed
triple and requires explicit confirmation. Editing rates or reason clears confirmation.
The editor captures its starting revision; a poll that observes another correction
blocks submission of the stale draft. There is no optimistic cache rewrite or
automatic retry. An uncertain outcome blocks the form until the operator reviews
refreshed history and reopens it. Successful saves invalidate detail, Runs and
leaderboard queries; other browsers use existing polling.

## Harbor ownership review

Pinned Harbor: `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`. Locally cached upstream
history inspected through `7d5285b4`, including `90e28af3`, `9a2e3b13` and
`1f84b4c0`. No remote fetch, upstream mutation or pin update was needed.

- `src/harbor/models/job/config.py`: native JobConfig owns execution configuration;
  no console correction field or competing price configuration is added.
- `src/harbor/models/trial/result.py`: `compute_token_cost_totals()` returns native
  input/cache/output/cost totals; these remain reported facts, never rewritten.
- `src/harbor/models/job/result.py`: `JobStats` aggregates those native totals;
  the existing estimate formula consumes reported stats without claiming billing
  authority or changing cost enforcement.
- The pinned model/CLI source and intervening cached history do not supply an audited
  HF-console rate correction. This feature belongs to Harbor-HF's shared display
  projection and leaderboard, not Harbor execution. No Harbor internal imports,
  agent patch, retry loop, additional JobConfig field or new native result is added.

## Validation scope

Synthetic local tests cover schema/request validation, unpriced history, swapped rates,
concurrent edits, replay, ambiguous writes, projection synchronization failures,
transaction rollback, overlapping rebuild fences, read/schema/identity/sequence
failures, deleted/regressed known history, SQL-only queries, native/control byte
preservation, fresh HF adapter reads, operator/CSRF/write-mode checks, and browser
confirmation/conflict handling and cross-browser estimates. No private task subset,
profile, credential or live runtime is used. Full command results and any existing
repository-wide validation gaps are recorded in the private implementation notes.

## Summary headline

The inference-cost card prioritizes native reported cost, including zero. When it
is absent, a finite, nonnegative shared estimate becomes the same-size headline,
explicitly labeled **Estimated** with **Launch rates** or **Corrected rates**.
The existing tooltip retains effective rate provenance and partial-usage/not-billing
caveats. With reported cost present, an available estimate remains secondary.
Unavailable or invalid estimates stay a dash when reported cost is also missing;
unavailable correction history never permits a stale launch or browser-scenario
fallback. No native cost, shared arithmetic, audit history or coverage count changes.

This display-only refinement rechecked pinned Harbor `src/harbor/models/job/result.py`
(`JobStats.cost_usd`) and `src/harbor/models/trial/result.py`
(`compute_token_cost_totals()`), plus the 19 cached commits through `7d5285b4`.
Those files have no intervening change requiring a pin update. No schema, persisted
field, API value, execution behavior or browser-local scenario is added or changed.
