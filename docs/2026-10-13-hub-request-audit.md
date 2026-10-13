# Hub request audit

Date: 2026-10-13. Source revision: `ed105fa`.

## Summary

Harbor-HF sends far more requests to the Hub, the Bucket and the Jobs proxy than its work needs.
The worst case is the reconciler. For each active run, it downloads every trial result again on
every pass, without cache. The old Jobs listing on a namespace with about 50,000 finished Jobs was
reported as a load problem, but these Bucket reads are larger.

This note records each finding and proposes request limits. No limit here is implemented yet,
except the live-only Jobs listing from #248.

## Findings

Rates are for one large run: 615 trials, the default 15-second reconcile interval.

| # | Component | Behavior | Rate | Status |
|---|---|---|---|---|
| 1 | Reconciler | For each active run, each pass downloads every trial's `result.json` with `fresh: true`, once in the run loop and again in the closing refresh (`projection.ts`, `readAndCommit`). | about 5,000 Bucket downloads per minute | Open |
| 2 | Sandbox SDK (`huggingface_hub` `_sandbox.py`, used by Harbor's `HFSandboxEnvironment`) | `wait_ready` requests `/health` every 0.15 s for up to 120 s and calls `inspect_job` every 2 s while a sandbox starts. | about 400 requests per minute for each starting sandbox, up to 800 per trial | Open, upstream |
| 3 | Parent worker | After each trial, `_upload_tree("attempt-costs")` uploads all receipts again, not only the new one (`bucket_artifacts.py`). | n(n+1)/2 uploads: about 190,000 for 615 trials | Open |
| 4 | Parent worker | `finish` lists the whole `job/` tree recursively and uploads every file again. `restore` downloads the whole run folder at each parent start. | the full run folder, at each start and at the end | Open |
| 5 | Workbench | The browser polls the setup and its logs every 1 s, and each setup GET calls the Hub (`getSetup` then `refreshRemote`). The CLI `--wait` default is 1 s (minimum 0.2 s) for up to 65 minutes. The server's follow loop calls `getJob` after each 5-second log slice and retries after 1 s. | about 60 to 120 Hub requests per minute for each setup test and viewer | Open |
| 6 | Leaderboard API | Each request lists `runs/` and reads every `run.json` with `fresh: true`, then assembles each replacement tree. Run records never change. | about 190 Bucket downloads per page load | Open |
| 7 | Console progress panel | The progress reader lists every finished trial again every 5 minutes and each unfinished trial every 30 s while the run page is open. | about 125 Bucket listings per minute for a 615-trial run | Open |
| 8 | Startup | A full rebuild downloads every trial result of every run with `fresh: true`, one run at a time but all trials of a run at once. | about 17,000 downloads, up to 615 in flight | Open |
| 9 | Reconciler, Jobs | The Jobs listing paged through the whole role history at least twice per pass. | about 1,400 requests per minute | Fixed in #248: 16 per minute when idle |

## Good-citizen rules

1. **No history scans.** Every Jobs listing has a label filter and a stage filter. Every Bucket
   listing is shallow or limited to one trial. Operator diagnostics follow the same rule, and they
   inspect a known Job by ID.
2. **No work when idle.** When no run is queued, running or settling, the service sends no Hub,
   Jobs or Bucket request, except one safety pass every 10 minutes.
3. **Read once what does not change.** Run records, finished trial results, final Job stages and
   receipts are kept in memory. A mutable file is read again only when its listing identity
   changes.
4. **Poll slowly and back off.** A wait for a state change starts at no less than 1 second and
   doubles up to 30 seconds. A stream is preferred to a poll.
5. **Bound concurrency.** At most 8 Hub or Bucket requests are in flight per process.
6. **Retry politely.** Retry only HTTP 429, HTTP 5xx and network errors. Honor `Retry-After`. Use
   exponential backoff with jitter and at most 3 attempts.
7. **Test the budget.** Each loop has a request budget that a test asserts.

## Proposed limits

| Component | Now | Proposed |
|---|---|---|
| Reconcile interval while a run is active | 15 s | 30 s |
| Reconciler when idle | 4 Jobs requests every 15 s | none; one safety pass every 10 minutes |
| Jobs requests per check | 2, one per role | 1, stage filter only; the service sorts parents and trials |
| Jobs checks per pass | at the start, for each active run, and at the close | 1 per pass, plus one right before a start or a cancel |
| Trial results read per pass, per active run | every trial, twice, uncached | only new or unfinished trials, once |
| Bucket requests per pass, per active run, with no change | about 1,230 | at most 5, plus 1 for each newly finished trial |
| Startup rebuild concurrency | all trials of a run at once | 8 |
| Parent: receipts uploaded after a trial | all receipts | the new receipt |
| Parent: upload at the end | every file again | only `config.json`, `lock.json`, `result.json` and changed files |
| Parent: restore at start | the whole run folder | only the files that Harbor's resume reads (to be checked in Harbor) |
| Workbench browser poll | 1 s, each poll calls the Hub | 5 s, served from server state |
| Workbench CLI `--wait` | 1 s default, 0.2 s minimum | 5 s default, 2 s minimum |
| Workbench server Job check | about every second while queued | every 15 s, backing off to 60 s; logs by stream |
| Leaderboard API | re-reads every run record | served from the projection, with `Cache-Control: max-age=60` |
| Console progress panel | re-checks finished trials every 5 minutes | never re-checks a finished trial; unfinished trials every 30 s while the run is active |
| Sandbox readiness (upstream) | `/health` every 0.15 s, `inspect_job` every 2 s | `/health` backoff from 0.5 s to 5 s, `inspect_job` every 10 s |
| Router inference for agents and judges | fixed concurrency; HTTP 429 retried | start at 6 per route, halve on HTTP 429, honor `Retry-After` |

With these limits, a 615-trial run needs about 2 Jobs requests and 10 to 30 Bucket requests per
minute in the control service, plus one upload batch for each finished trial. An idle service
needs about one request every 10 minutes.

## Next steps

1. Fix findings 1 and 3 to 8, and the idle Jobs checks, in Harbor-HF, with request budgets in
   tests.
2. Report finding 2 to the `huggingface_hub` maintainers.
3. Keep hosted control Spaces paused until those fixes are deployed.
