---
title: Shared run archive
author: Harbor-HF maintainers
date: 2026-09-09
tags: [architecture, api, web]
---

# Shared run archive

Archive hides a run from the default Runs view for every authenticated user.
Running jobs continue. Restore is available through direct detail URLs, including
terminal runs. Archive does not delete anything or change execution, artifacts,
reported timing, pricing preferences, costs, roles, or leaderboard eligibility.

## Authority and concurrency

The existing canonical Bucket stores optional
`runs/<run-id>/presentation.json`, validated as `RunPresentationV1`:
`schema_version`, `run_id`, `archived`, `revision` (integer, at least 1),
`updated_at` (server clock), and `actor` (private authenticated subject).
It is separate from immutable `run.json`, mutable execution `state.json`, and
Harbor's `job/` artifacts. Do not copy actor identities into public fixtures or logs.
There are no additional resources, credentials, annotation fields, or CLI commands.

A missing record means unarchived, revision 0. Read responses represent it as
null; they do not fabricate an audit timestamp or actor. Restore writes false,
never deletes the record. A malformed JSON/schema, mismatched identity, or failed
presentation read is isolated from execution projection and reconciliation:
valid control runs still participate in cancellation, orphan cleanup and cost
checks. Their native records, states, results and costs are unchanged.

Each SQL list/detail response includes ephemeral `presentation_available`.
False means the display metadata could not be validated or synchronized; the
`presentation` value is last-known only, including its archived flag. With no
last-known value, null means **unknown**, not unarchived. Unknown runs remain
discoverable in the default Runs view with an explicit warning; a known archived
run remains in the Archived/All views with a last-known warning. Archive mutations
are disabled while unavailable. Missing records observed successfully are valid
unarchived state. A fresh valid rebuild or service synchronization restores
availability. Neither availability nor cache state is durable Bucket metadata.

`PATCH /api/v1/runs/:run_id/presentation` accepts only `archived: boolean` and
`expected_revision: nonnegative integer`. Existing authentication, session CSRF,
operator-role (403), and write-mode (503 `write_disabled`) checks apply. Readers
can see archived runs but cannot change them.

The existing service per-run lock encloses a fresh Bucket read, schema/identity
validation, expected-revision check, write, and one-row projection update. Stale
intent returns 409 **before** checking whether the requested boolean already
matches, but only after synchronizing freshly validated Bucket presentation into
SQL. Thus a persisted revision 1 with cached revision 0 converges on conflict:
the next GET returns revision 1 and Restore can safely send expected revision 1.
A matching revision and unchanged boolean returns the current value without
rewriting audit fields. There is no automatic mutation retry. Validation, write,
or projection synchronization failures return safe 503
`presentation_update_failed` and mark the projected presentation unavailable.
Invalid existing metadata is never overwritten by the API.

GET remains SQL-only: a successful cached GET is not proof of a new Bucket read.
Unavailable responses keep browser writes disabled even after a successful GET;
ordinary polling/reload can observe a subsequent valid reconciliation. When a
network failure leaves the client with an older available response, a manual
retry is still revision-guarded, and the conflict path synchronizes before 409.
If synchronization fails, it returns 503/unavailable rather than a misleading
recoverable conflict. No operation calls `setDesiredState` or any Jobs method.

**Single control authority only:** the provider adapter exposes ordinary `put`,
not conditional writes/CAS. The process-local lock is not a distributed lock.
Concurrent controllers or out-of-band presentation writers are unsupported.
Sequential service/projection instances reconstruct shared state from the Bucket;
that test does not establish safe concurrent multi-controller writes.

## Projection and browser

The existing `runs` table gains nullable `presentation_body` and ephemeral
`presentation_available` with additive migrations for old disposable SQLite files.
Old caches start unavailable until validated. Rebuild uses its existing Bucket
listing and isolates presentation validation failures per run. Within the rebuild
transaction it preserves current SQL presentation **and availability** when a
projection-local write committed after that rebuild began, even at equal durable
revision or with null presentation. A monotonic in-memory generation is captured
before the first await; per-run generations advance on direct synchronization,
unavailability marking, and every successful rebuild commit (even unchanged
snapshots). Failed transactions do not advance generations. Rebuilds are not
serialized: committing a newer snapshot fences older overlapping reads, whether
valid or failed. This is conservative commit ordering, not a claim that an
in-flight read has the freshest Bucket value: an overlapping rebuild whose epoch
was fenced retains current SQL and a subsequent rebuild can revalidate it.
A validated rebuild started after a failure can restore
availability at the same revision or with null presentation. Higher durable
revisions are also retained, assuming the single service never deletes metadata.
Removed runs are not retained. Generations are disposable, projection-local
ordering, not Bucket revisions, provider CAS, or coordination between controllers.
All cache writers must use the same Projection instance in the single authority;
read failures never write or increment durable presentation metadata. No extra
Bucket reads are introduced.

Run list/detail GETs remain SQL-only, returning all runs with optional/nullable
presentation and availability through generated OpenAPI contracts. Archive filtering is browser
presentation, not reconciler input. Successful mutations update one projected row
and refresh only the run detail and list queries, not all Harbor history. Other
browsers see changes through existing ten-second polling. No overview progress
queries or extra polling loop are added.

The URL `archive` parameter supports `archived` and `all`; absence or invalid
values select **Not archived** (not “Active”, which could imply execution state).
The control combines with existing `role` and `q` filters and preserves other URL
parameters. Archived badges are display only. Archive/Restore is separate from
terminal-sensitive execution actions, hidden unless `writesAllowed`, disabled
while pending, and never optimistically changes run data. Backend authorization
remains decisive. Failed refetch keeps archive writes blocked with a reload action.
Browser-local pricing scenarios and Workbench drafts are unchanged.

## Boundary review

Pinned Harbor: `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`.
Cached history inspected through `1f84b4c0`, including native config validation,
viewer option schemas, and Hub rename/transfer changes. No pin update in this
history supplies shared HF-console visibility; the Harbor pin remains unchanged.

| Surface | Source checked | Owner / review decision |
| --- | --- | --- |
| Job configuration | Harbor `src/harbor/models/job/config.py` | Native `JobConfig`; no HF-console archive field added or mirrored. |
| Hub job operations | Harbor `src/harbor/cli/jobs.py`, `src/harbor/cli/hub.py`; history `ede21aa5` | Hub rename/transfer and artifact archives are not HF-console visibility. |
| Run/presentation storage | `packages/contracts/src/paths.ts`, schemas; `packages/control-core/src/store.ts` | HF display-only record in the existing Bucket; ordinary put, no provider CAS. |
| Concurrency and projection | `packages/control-core/src/service.ts`, `projection.ts` | Fresh revision check under existing lock; transactional newer-revision preservation. |
| Authorization and API | `apps/control-api/src/app.ts`, `auth.ts`, `generate-openapi.ts` | Existing role/CSRF/write switch; generated single/list contract authority. |
| Browser | `run-archive.tsx`, `run-filters.ts`, `pages.tsx`, `queries.ts` | Shared visibility only; native pricing/time/role/filter/sort semantics retained. |

Tests cover isolated JSON/schema/identity/read failures with fake Jobs cancellation
and orphan cleanup, unknown and cached-archive warnings, SQL-only availability
responses, conflict synchronization after persisted-write/projection failure,
persistent synchronization failure, missing metadata and old SQLite migration,
no-op/stale/concurrent intent, independent projection reconstruction, old-rebuild
races for first archive and restore, safe partial failure, unchanged native data
and leaderboard, SQL-only reads, API authorization, and two-context browser polling
using one shared synthetic fixture (no live control runtime).

## Validation

- 846 unit tests and 53 synthetic browser tests pass, including equal-revision
  and null-presentation failure/recovery races and overlapping rebuilds.
- Formatting, lint, root/Space types, build, dependency audit, public privacy,
  whitespace, normal Slophammer and DRY checks pass. Six existing lint warnings
  remain. Generated output is deterministic.
- Global coverage remains below the unchanged 85% gate: 80.86% lines, 78.80%
  statements, 80.15% functions and 73.09% branches.
- Baseline and mutation checks are blocked by the missing
  `slophammer-baseline.json` and `scripts/check_mutation.py`. No gates were lowered.
- No live control mutation, inference, deployment, credential transfer or new
  remote resource is included.
