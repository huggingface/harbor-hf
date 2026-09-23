# Combined-result responsiveness

## Scope and ownership

Local implementation only. No deployment, run control, inference, credential
transfer or resource creation. The browser's existing 60-second timeout is not
extended. A read-only hosted inspection exceeded that limit despite eventually
returning an available native aggregate; private run evidence is not a fixture.

Harbor-HF owns remote Bucket I/O and read-only HTTP request coordination. Harbor
continues to own replacement aggregation and native result meaning. Checked pinned
Harbor `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`:

- `src/harbor/job_plan.py`: `JobPlan.aggregate`, `aggregate_stats` and native
  `trial_results`; these remain the authoritative aggregation APIs.
- `src/harbor/models/job/result.py`: `JobResult.trial_results` and
  `JobStats.from_trial_results`. No replacement metric or native field is added.
- Relevant planning/result history, including `00c19fe2` (JobPlan extraction)
  and `e5e46809` (empty progress metrics).
- Existing bridge `packages/harbor-hf-agents/src/harbor_hf_agents/replacements.py`:
  its `aggregate` still selects and validates native evidence and invokes Harbor.

This is an optimization of existing HF-owned transport, not an implementation of
missing general Harbor behavior. No Harbor issue or temporary native workaround
is required. Durable schemas, projection tables, native configuration, API and UI
values are unchanged. There is no new persisted aggregate or source-byte cache.

## Changes

Previously each trial required a shallow directory listing before downloading its
known native `result.json` path. The reader now fetches that exact path directly.
Job-root listings still discover trial directories freshly; unrelated logs,
trajectories and artifacts are not downloaded or recursively enumerated.

- Only an explicit object-not-found (`ENOENT`, including adapter-mapped HTTP 404)
  is treated as an absent result. Missing results retain unfinished-evidence
  semantics. Permission, transport and malformed-JSON failures are not absence.
- Full fresh native bytes, trial-name checks, payload bounds, receipt identity,
  unknown-cost coverage and completion validation are preserved. The existing
  eight-operation per-reader bound remains; concurrency is not increased.
- Overlapping view requests with the same run and freshly discovered record graph
  share one unfinished inspection. Every caller first rediscovers records. A new
  descendant or changed record cannot join an older graph's inspection.
- Responses are cloned for consumer isolation. Settled work, including errors and
  unavailable responses, is removed immediately. A subsequent request performs
  fresh discovery and evidence reads, rather than renewing cached response age.
  The existing identity-keyed native aggregate cache is unchanged.
- Different runs/graphs remain independent. This is not a global storage limit,
  an execution scheduler, a durable cache or a promise of server-side cancellation
  after a browser timeout.

## Offline comparison

Compared the pre-change implementation against the patch using the actual view
and evidence reader with synthetic filesystem-backed evidence: 445 original and
four replacement trial results, two records, no attempt receipts, and 10 ms added
to each storage read/list. Native aggregation and completion were test stand-ins.
The temporary profiling fixture was removed after measurement.

| Inspection | Before time | After time | Before reads/listings | After reads/listings |
| --- | ---: | ---: | ---: | ---: |
| Cold | 1,390 ms | 716 ms | 457 / 454 | 457 / 5 |
| Warm | 1,420 ms | 711 ms | 457 / 454 | 457 / 5 |
| Four overlapping, same graph | 1,933 ms | 715 ms | 1,828 / 1,816 | 463 / 8 |

Single-request peak storage I/O stayed at eight. Four overlapping requests peaked
at 32 before and eight in this fixture after. Each extra caller still performs
its own fresh record discovery. These are evidence-loading measurements, not
hosted latency guarantees or verification of a benchmark score. Warm requests
still download native evidence; high provider latency can still exceed the
browser deadline. A deployment requires separate approval and hosted validation.

## Regression coverage

Tests assert one job-root listing for a 445-trial source, no per-trial listings,
shared overlapping inspections, independent runs, response isolation, cleanup
following discovery/inspection failures, and a new descendant appearing while
an older inspection is held in flight. They also distinguish absence from denied
or malformed result reads and preserve unknown incurred costs. Existing native
fingerprint, changed/deleted source, receipt, payload-limit, failed-replacement
and fresh-state tests remain in place.

## Validation and remaining gate

- Node 22.22.0: format, lint, types, 1,645 unit tests, build, generated checks and
  dependency audit pass. Lint retains existing non-null assertion warnings.
- Focused replacement coverage: 97.83% lines, 92.63% branches, 100% functions,
  97.51% statements; all configured 85% thresholds pass for changed modules.
- All 77 browser tests pass with two workers against an explicitly started local
  server. Automatic web-server startup stalled and was stopped before that rerun;
  no assertions or timeouts were weakened. The local server was stopped afterward.
- Root Python Ruff/format/ty, 102 tests at 89.10% and dependency audit pass.
  Agent Ruff/format/ty and 598 tests pass. Both Dockerfiles build for linux/amd64.
  Slophammer baseline and DRY checks pass; privacy and diff checks pass.
- An additional repository-wide `npx vitest run --coverage` run fails the existing
  global 85% coverage gate, despite all 1,645 tests passing. Patched totals:
  lines 83.40%, functions 84.16%, statements 81.82%, branches 77.32%.
- Repeating that command against the unchanged implementation and tests confirms
  a pre-existing shortfall: lines 83.39%, functions 84.15%, statements 81.80%,
  branches 77.31%. Original files were temporarily restored for this comparison
  and the patch restored afterward; no worktree or history rewrite was used.
  No threshold, coverage scope or test was weakened to make the global gate pass.

Local implementation is available for review, but the global coverage gate
remains unresolved. No release readiness or hosted improvement is claimed.

## Release follow-through: coverage hold resolved

Integrated current main without dropping the reviewed endpoint-connection or CI
changes. The historical coverage hold above is resolved, not waived. The report
had counted workspace TypeScript and its compiled JavaScript as separate files:
API tests import compiled workspace exports while unit tests import their source.
Enabling TypeScript source maps maps both executions to their original source.
No source is excluded and no coverage threshold or test scope is reduced.

Added regression tests for emitted relative source maps, read-only Git source
location failures, and the existing generated browser pricing schema's closed
objects, required fields, nullable rate boundaries and malformed stored data.
These are build/test corrections, not new Harbor behavior or API/schema fields.
The first control-image build exposed an installer test placed outside its normal
`test/` directory; moved it into that existing directory rather than altering the
production build exclusions or adding test dependencies to the image.

Validation after integration: 1,667 Node tests, full-repository coverage at 91%
lines, 85.08% branches, 88.31% functions and 89.31% statements; all 77 browser tests
pass. Configured format, lint, types, build, generated checks, dependency audit,
Python checks, Slophammer and both Docker builds are required before publication.
Parent worker inputs remain unchanged. The TypeScript build setting is
control-only; no parent image publication is needed.

## Hosted release outcome

PR #229 merged after exact-head CI; merged revision
`66c9cbf0cf0f5a4d6869006e91208e48433502d7` was deployed with writes disabled during
cutover and restored after provenance, readiness, data and idle-inventory checks.
Runtime, assets and native aggregation verified successfully with unchanged
resources and worker images. No benchmark execution was started or interrupted.

**The live responsiveness problem remains unresolved.** Hosted inspections still
exceeded the browser's existing deadline, even though they returned the expected
native aggregate. The offline timing comparison must not be interpreted as a
hosted improvement claim. Remaining transport/inspection costs need measured
follow-up; this release did not add a timeout extension or speculative cache.
Private run identifiers, results and detailed operational evidence are not
published here.
