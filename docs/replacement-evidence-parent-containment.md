---
title: Replacement evidence and parent error containment
author: Harbor-HF maintainers
date: 2026-09-11
tags: [harbor, replacements, lifecycle]
---

# Replacement evidence and parent error containment

## Ownership and reviewed source

Harbor revision `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e` remains
unchanged. Inspected native `src/harbor/job.py`, `job_plan.py`,
`models/job/config.py`, `models/job/lock.py`, `models/job/result.py`,
`models/trial/result.py`, `models/verifier/result.py`, and
`environments/hf_sandbox.py`, and their pinned history. Relevant history includes
native agent preflight/config validation and the HF Sandbox provider addition
and command-execution correction. The installed native files match the pin.

`Job.create()` performs native preflight and constructs execution;
`JobPlan.from_resolved`, `build_trial_configs`, and `aggregate` own native
planning and results. Native `RetryConfig` controls trial retries, not an external
HF parent Job that fails before `Job.create()`. No native API owns Harbor-HF's
operator-reviewed cross-run fingerprint or external parent restart admission.
`VerifierResult.rewards` is explicitly `float | int`: Pydantic preserves either
input type. Neither native models nor the inspected planning API supply the
transport-equivalence rule required by the already approved replacement bridge.

## Numeric evidence equivalence

JavaScript JSON parsing/stringifying turns integral floats such as `1.0` into
integers. The old review path therefore hashed different native union-field types
than the parent's direct source reader. Both could derive exactly the same child
configuration while the immutable source check rejected it.

Normalize exact integral floats once, at `Evidence.parse`, **before** native model
validation. Harbor then restores its declared types, including explicit float
fields. Keep the existing canonical JSON encoder, hash structure, native field
names and `sha256:` source prefix. The separate public review fingerprint remains
bare hexadecimal and still binds selection and budget.

Do not normalize the final native hash payload: that also changes explicit native
float fields and invalidates existing review hashes. Offline replay against the
saved source confirmed that input normalization matches the existing immutable
review fingerprint and child configuration without rewriting any source bytes,
run record or stored hash. The real parent source reader and preflight succeed.
This is evidence for that reviewed source, not a guarantee for every possible
historical noncanonical number in arbitrary metadata; mismatches still fail
closed. There is no dual hash, fallback reader or evidence migration.

The rule traverses nested JSON maps and arrays. It preserves booleans and
fractional floats, including exponent notation; negative floating zero becomes
integer zero. Arbitrary integers never pass through floating point. Non-finite
values are rejected at the evidence boundary; the existing `allow_nan=False`
encoder remains a second guard. This does not
repair JavaScript precision loss for integers beyond its safe range: changed
integer evidence must still mismatch the parent's exact source, never round into
an accepted identity.

The cross-language regression now reads raw fixture files through the actual TS
`ReplacementEvidence` loader and `NativeLaunch` subprocess transport. The native
launch entry point consumes actual stdin, rather than returning a response
computed before Node serialized the request. Only external admission and task
downloads are stubbed; native validation, fingerprinting, immutable TS storage,
and the independent parent SDK reader/preflight remain real and offline. The
existing native planner/admission tests remain in place.

The bridge's removal condition is unchanged: replace it at the first reviewed
Harbor revision providing equivalent cross-run provenance and coverage APIs. No
future upstream SHA or general native replacement implementation is invented.

## Parent lifecycle policy

HF's typed `ERROR` stage cannot certify whether a failure is deterministic or
transient. The controller therefore pauses on **any unacknowledged owned parent
error**, rather than parsing arbitrary logs or repeatedly spending on startup.
This deliberately replaces automatic retry of failed HF parents; non-error
terminal Jobs retain the fixed restart delay. Native Harbor trial retries are
unchanged. Failed trial evidence in a normally completed parent is not a parent
error and does not trigger this policy.

Existing desired pause/cancel, native completion, cost-stop finalization,
live-parent adoption and orphan cleanup precede the new no-parent launch veto.
Repeated observations persist only one pause. A live parent is not cancelled
because another historical parent errored. Unknown recorded-parent liveness
continues to block launch. Unrelated runs retain their normal safety handling.

Explicit resume acknowledges observed owned parent error IDs while holding the
same run lock used by reconciliation. All recorded parents are inspected during
resume, including when another parent is active. A newly failing parent is never
implicitly acknowledged. Acknowledgments survive projection rebuild; neither
provider timestamps nor SQLite receipt time determine whether an operator has
reviewed an error. Operator review is required even after deployment fixes the
underlying defect, and inference/budget checks still apply on the next start.

## Schema and API comparison

The sole new optional durable value is
`RunState.acknowledged_parent_failures`: unique HF parent Job IDs explicitly
acknowledged by operator resume. It records a Harbor-HF operator decision, not
provider status, a native retry count, or Harbor progress. Existing parent IDs
alone cannot represent that decision; `updated_at` also changes on adoption, and
`actor` must not be overloaded as a hidden restart state machine. The optional
field's absence means no errors were acknowledged, not a legacy reader.

The versioned JSON Schema remains authoritative, with generated TypeScript and
OpenAPI. Existing resume authorization, CSRF/write-mode gates, control intent,
three-table projection and parent ownership are retained. No new API endpoint,
resource, credential, native configuration field, result writer, or scheduler is
added. The parent reads existing desired intent but never writes controller state.
The UI uses the existing paused state and control actor to explain the stop; the
actor is explanatory only, never a launch or resume authorization input.

## Follow-up validation gate closure

The initial 501-test agent run passed tests but measured 76.87% whole-package
coverage; the prescribed Slophammer baseline was also missing. Those historical
failures remain recorded in the project authorization history, not waived.

Offline test-only follow-up adds 97 cases for parent ownership rejection,
immutable receipt replay/conflicts, atomic-write cleanup, nested controlled stops,
DSH session parsing and native trajectory metrics, sandbox upload/install
boundaries, and FX protocol/usage validation. External execution is mocked;
parsers, native models, receipt filesystem operations and validation paths execute
real product code. No production behavior, coverage omission, exclusion, threshold,
provider admission rule or resource changes accompany these tests.

Fresh whole-agent coverage is **87.33%** (598 tests; 2,304 statements, 292 missed).
This is the package's statement-coverage measurement, not a branch-coverage claim.
Root coverage remains **89.10%** with 102 tests. Root and agent Ruff, format and ty
checks pass, as does the root dependency audit. Node formatting, lint, types,
1,575 unit tests, build, generated checks and dependency audit pass; all 76 browser
tests pass. Both Dockerfiles build locally for `linux/amd64` without publication.
Existing native numeric transport and parent/controller regression tests remain in
the passing suites. No live private replay or remote integration was repeated.

The installed Slophammer CLI documents `check . --baseline-write` as its snapshot
command. Its native baseline writer/reader were inspected. An ordinary check
first reported zero findings across all 27 production files; the official writer
then generated `slophammer-baseline.json` with version 1 and an empty findings
array. It contains no paths or suppressed debt. Regeneration is byte-identical.
`uv run slophammer-py check . --baseline` passes with zero baselined and zero new
findings, and `uv run slophammer-py dry .` reports zero candidates. Do not grow the
baseline to hide new findings.

## Release boundary

This is local implementation and offline validation only. Independent review must
precede publication. Matched source/image deployment to existing resources is a
separate release phase. No run launch, resume, inference grant, credential change,
paid canary or resource creation accompanies this change.
