# Hub request audit

Date: 2026-10-13. Audited source revision: `ed105fa`.

## Summary

Harbor-HF sent far more requests to the Hub, the Bucket and the Jobs proxy than its work needed.
The worst case was the reconciler. For each active run, it downloaded every trial result again on
every pass, without cache. The old Jobs listing on a namespace with about 50,000 finished Jobs was
reported as a load problem, but those Bucket reads were larger.

This note records each finding, the rules that Harbor-HF now follows, and the limits that the same
change implements. [`AGENTS.md`](../AGENTS.md) makes the rules mandatory for new code.

## Findings

Rates are for one large run: 615 trials, with the old 15-second reconcile interval.

| # | Component | Behavior before | Rate before | Now |
|---|---|---|---|---|
| 1 | Reconciler | For each active run, each pass downloaded every trial's `result.json` with `fresh: true`, once in the run loop and again in the closing refresh (`projection.ts`, `readAndCommit`). | about 5,000 Bucket downloads per minute | A finished trial's row is reused. An unfinished trial is read again only when the run's job metadata or trial folders change. When Harbor's `n_completed_trials` is lower than the finished rows, a trial ran again under its name, and every result is read again. |
| 2 | Sandbox SDK (`huggingface_hub` `_sandbox.py`, used by Harbor's `HFSandboxEnvironment`) | `wait_ready` requests `/health` every 0.15 s for up to 120 s and calls `inspect_job` every 2 s while a sandbox starts. | about 400 requests per minute for each starting sandbox, up to 800 per trial | Open: upstream code. |
| 3 | Parent worker | After each trial, `_upload_tree("attempt-costs")` uploaded all receipts again, not only the new one (`bucket_artifacts.py`). | n(n+1)/2 uploads: about 190,000 for 615 trials | Only new or changed receipts are uploaded. |
| 4 | Parent worker | `finish` listed the whole `job/` tree recursively and uploaded every file again. `restore` downloaded the whole run folder at each parent start. | the full run folder, at each start and at the end | `restore` downloads the run files, receipts, job metadata, Harbor's `.`-folders, and each trial's `config.json` and `result.json`. `finish` uploads job metadata and the trial folders that changed. |
| 5 | Workbench | The browser polled the setup and its logs every 1 s, and each setup GET called the Hub. The CLI `--wait` default was 1 s (minimum 0.2 s). The server's follow loop called `getJob` after each 5-second log slice and retried after 1 s. | about 60 to 120 Hub requests per minute for each setup test and viewer | The browser polls every 5 s and the CLI every 5 s (minimum 2 s). The server asks the Hub for a Job's stage at most every 15 s, keeps a log stream open for 30 s, and backs off to 30 s while no log arrives. |
| 6 | Leaderboard API | Each request listed `runs/` and read every `run.json` with `fresh: true`. | about 190 Bucket downloads per page load | The listing stays fresh, so a new replacement run still withholds its original run. A run record never changes, so each one is read once per process. |
| 7 | Console progress panel | The progress reader listed every finished trial again every 5 minutes while the run page was open. | about 125 Bucket listings per minute for a 615-trial run | A finished trial is not observed again while its folder is listed, unless Harbor's `n_completed_trials` drops below the finished records. Unfinished trials keep their 30-second check while the page is open. |
| 8 | Startup and full refresh | A full rebuild downloaded every trial result with up to one request per trial in flight. A pause, resume or cancel ran a full rebuild of every run. | about 17,000 downloads, up to 615 in flight, at startup and at each pause | At most 8 Bucket requests are in flight per store. A pause, resume or cancel rebuilds only its run. |
| 9 | Reconciler, Jobs | The Jobs listing paged through the whole role history at least twice per pass. | about 1,400 requests per minute | One stage-filtered request per check (#248 and this change). |

## Rules

1. **No history scans.** Every Jobs listing has a live stage filter. Every Bucket listing is
   shallow or limited to one trial or one Harbor-owned folder. Operator diagnostics follow the same
   rule, and they inspect a known Job by ID.
2. **No work when idle.** When no run is queued, running or settling, the service sends no Hub,
   Jobs or Bucket request, except one safety pass every 10 minutes.
3. **Read once what does not change.** Run records, finished trial results, final Job stages and
   uploaded receipts are read or sent once per process.
4. **Poll slowly and back off.** A wait for a state change starts at no less than 1 second and
   grows. A browser or CLI poll reads server state and is not faster than 2 seconds.
5. **Bound concurrency.** At most 8 Bucket requests are in flight per store.
6. **Retry politely.** Retry only HTTP 408, 429, 5xx and network errors, with growing delays.
7. **Test the budget.** Each loop has a request-count test.

## Reconciler

- The default interval is 30 seconds (`HARBOR_HF_RECONCILE_INTERVAL_MS`).
- A pass with no queued or running run and no run in its settling window returns at once. It sends
  no request. One safety pass every 10 minutes still finds Jobs and runs that the process did not
  create or see.
- A pass lists live Jobs once, with one request. A run that should run and has a live parent uses
  that listing. Every other run lists again right before it can start or stop Jobs.
- The pass has no closing listing. Its close uses the latest listing and the parents that it
  started.
- A pause, resume or cancel adds its run to the settling window, so late children are found within
  one pass.
- When a run leaves the settling window, the pass reads all of its trial results once more.

The trade-off: a Job that appears for a run that the process does not watch, such as a Job that
another process started for a paused run, is found by the next safety pass, within 10 minutes.

## Request budget

| Case | Before | Now |
|---|---|---|
| Idle service, per minute | about 1,400 Jobs requests and 4 Bucket listings | about 0.2 requests (one safety pass per 10 minutes) |
| Active 615-trial run, per pass, no trial started or ended | 4 or more Jobs requests and about 1,230 Bucket downloads | 1 Jobs request, about 7 shallow Bucket listings, no trial read |
| A trial starts or ends | no change | one read for each unfinished trial in the next pass |
| Parent: cost receipts for a 615-trial run | about 190,000 uploads | 615 uploads |
| Leaderboard page load | about 190 Bucket downloads | 1 Bucket listing |

## Next steps

1. Report finding 2 to the `huggingface_hub` maintainers. Harbor-HF does not change the SDK.
2. Keep hosted control Spaces paused until this change is deployed.
3. After deployment, check the request rates of one idle hour and one small run.
