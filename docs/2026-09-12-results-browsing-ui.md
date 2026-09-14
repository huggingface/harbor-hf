# Results browsing follow-up

Local implementation only; no publication, deployment, run control or inference.
This preserves the native rollup and request-evidence work in `98b3338`.

## Ownership and native review

Harbor-HF owns presentation and browser request scheduling, not aggregation.
Inspected pinned Harbor `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`:

- `src/harbor/job_plan.py`: public `JobPlan.aggregate` and `aggregate_stats`,
  selected native `trial_results`, and delegation to `JobStats`.
- `src/harbor/models/job/result.py`: native `JobResult`,
  `JobStats.from_trial_results`, `increment`, counts and nullable token/cost totals.
- `src/harbor/models/trial/result.py`: `TrialResult.compute_token_cost_totals`.
  A present top-level agent context takes precedence over step contexts. A trial
  with at least one applicable reported cost can have a partial native sum.
- `src/harbor/models/job/config.py`, `models/trial/config.py` and
  `agents/factory.py`: `JobConfig.agents`, `AgentConfig.model_name`, `kwargs`,
  and `AgentFactory.create_agent_from_config`; relevant configuration history
  including `ac476798` and the existing JobPlan extraction review.
- [Existing replacement bridge/history review](2026-09-11-replacement-backend.md),
  including available native planning/result history through `e1be9bd3`.

Scores and tokens come directly from existing native results. The existing
conservative single-mean display parser remains unchanged. Selected cost is
`assembly.result.stats.cost_usd`, never the all-incurred subtotal or an estimate.
The UI counts cost availability in native selected trial evidence without
selecting trials or recomputing money. No API schema, persisted field, projection
table, backend cache, metric engine, source reader, execution state, provider
rule or native configuration alias was added. No new Harbor gap was required.

## Display behavior

- Runs discover relationships from the full existing run-list response before
  search/archive filters. Only rendered rows with known children enable expensive
  inspections. Recursive selection and aggregation remain in the native bridge.
- One native-result cell shows score, input/output/cache tokens and selected
  reported cost. Sorting is disabled for that cell: sorting by Original values
  while displaying asynchronous Combined values would be misleading. Exact
  numbers remain keyboard accessible.
- Failed replacements remain selected failures. Pending, invalid or expired
  Combined evidence never falls back to a favorable Original result.
- New direct children and newly discovered descendant edges fence old assemblies
  immediately. An inspection started before discovery must settle before a fresh
  inspection can clear the fence. Hidden/archived descendants still participate.
- Original status, progress and diagnostics remain Original. Replacement rows
  explicitly identify themselves as subsets. Shared and browser scenario
  estimates explicitly remain based on Original native usage, not Combined.
- Run detail displays recorded reasoning intent alongside native kwargs. Intent
  is verbatim submission metadata, not an inferred effective provider setting.
  Native model strings, including harness-specific query options, are unchanged.
- Detail's existing top rollup includes Combined tokens alongside its score;
  Original execution cards and full native JSON remain inspectable.

## Cost coverage

Selected cost displays state the number of native trial results missing reported
cost, with zero treated as reported and null as missing. Multistep coverage
matches native context precedence; a reported trial sum does not prove every
step reported a cost. Labels explicitly warn about partial within-trial costs.

All-incurred subtotal and existing `unknown_attempts` remain separately labeled,
including replaced-away executions. They are not the selected cohort cost.
Historical Original summaries often omit `trial_results`; their missing-cost
count is explicitly **unavailable**, not zero. The UI does not infer coverage
from aggregate tokens, errors, elapsed time or a successful outcome. It does not
fetch every run's trial history just to manufacture a browsing count.

## Performance and caching

- Runs and detail share the existing React Query replacement key and a 30-second
  fresh-response window. One page provider polls active inspections every 30
  seconds, skips hidden polling and refreshes stale observations on visibility
  or focus. Explicit Refresh also refreshes active combined inspections.
- At most two combined HTTP inspections start concurrently per browser module.
  Queued hidden rows skip their requests. Started work is shared per run across
  observer cancellation/remount, then removed immediately on success or failure.
  This is in-flight deduplication, not another completed-result cache.
- Polling/Refresh do not cancel and duplicate in-flight inspection. Fresh saved
  evidence is labeled while refreshing; failed refresh or age over 60 seconds
  hides Combined values and exposes Retry. The existing 60-second API timeout
  remains. Browser cancellation does not promise server-side cancellation.
- No cross-request Bucket evidence cache was added. Every backend inspection
  retains fresh relationship discovery and native identity validation. Browser
  limits do not impose a server-wide limit across users.

Offline synthetic backend profile: 445 Original plus five replacement trials,
10 ms latency per storage operation, mocked native aggregation/completion:

| Requests | Elapsed | Reads | Listings | Peak storage I/O |
| --- | ---: | ---: | ---: | ---: |
| Cold | 1,440 ms | 458 | 455 | 8 |
| Warm | 1,455 ms | 458 | 455 | 8 |
| Four overlapping | 2,040 ms | 1,832 | 1,820 | 32 |

These measure evidence loading only, not native aggregation correctness or hosted
latency. They justify avoiding eager inspections for all rows and duplicate
browser work. They also show why the existing native aggregate cache alone does
not remove storage traffic. Further server-wide optimization needs separate
measured work, not weaker freshness or a persisted aggregate.

## Validation and review

- Independent review found two medium issues: grandchild discovery did not fence
  ancestors, and queued-then-started requests could duplicate on remount. Both
  were fixed and independently re-reviewed: GO, no remaining blocking finding.
- Offline query tests cover six cold rows with peak two requests; filtering to
  one row leaves only that row polling. They cover hidden polling, queued skips,
  repeated observers, StrictMode, admitted cancellation/remount, success/error
  cleanup, slow refresh, new direct and deeper relationships, and explicit Retry.
- Component tests cover native selected versus incurred cost, missing evidence,
  failed replacements, stale data, disabled asynchronous sorting, subset labels,
  and intent/kwargs conflicts. No provider requests or trial commands are run.
- Final unit validation: 1,632 Node tests. Changed display/coverage modules have
  100% line/function coverage, 98.18% branch coverage and 98.83% statements across
  92 focused tests; all configured 85% thresholds pass.
- Root Ruff/format/ty, 102 tests at 89.10% coverage and dependency audit pass.
  Agent Ruff/format/ty and 598 tests pass. Both Dockerfiles build for linux/amd64.
  Node format/lint/types/build/generated checks and dependency audit pass.
  Slophammer baseline and DRY checks pass, as do public privacy and diff checks.
- Browser validation is recorded in the project completion entry. The initial
  automatic web-server startup stalled and was stopped; the full rerun uses an
  explicitly started isolated local web server. No test assertion was weakened
  to hide the layout issue: collapsed spacing was reduced to retain the existing
  waffle-above-the-fold contract at desktop and mobile sizes.

No publication, deployment, paid work, credential transfer, run mutation or native
artifact rewrite is included. Local commits require separate release approval.

## Approved release follow-through

The subsequent PR scope includes the narrow
[built-in inference review correction](run-inference-access-review.md). The
existing authoritative binding policy distinguishes no named binding from a
reviewed named binding. Its ephemeral response contract and generated browser
types now express that distinction; no durable schema, native configuration,
grant or admission rule changes. No-binding review makes no credential-presence
or authentication claim and cannot offer an approval action.

Independent security review found no blockers. The combined local release
validation passes 1,641 Node unit tests and 77 browser tests, including named
and no-binding replacement flows. All configured Node, Python, agent, Docker,
Slophammer and privacy gates pass. Publication and exact-green-head squash merge
are separately approved in the project authorization; deployment, image
publication, credential transfers and paid execution are not included.
