<p align="center">
  <img alt="harbor-hf" src="assets/harbor-hf-logo.svg" width="440">
</p>

`harbor-hf` is a Harbor control plane for running benchmark runs on Hugging Face infrastructure. It submits pinned work to HF Jobs, tracks retries and Endpoints, preserves evidence in an HF Bucket, and publishes queryable results without running the benchmark on your machine.

A hosted installation uses two persistent resources: one publicly reachable, application-protected control Space and one private Bucket. The Space serves the API and web console while its single control process reconciles immutable records stored in the Bucket.

## Install the CLI

The CLI requires Python 3.12 or newer. Install it with [uv](https://docs.astral.sh/uv/):

```bash
uv tool install harbor-hf
```

Log in to Hugging Face, then point the CLI at your control Space:

```bash
hf auth login
export HARBOR_HF_CONTROL_URL=https://<control-space>.hf.space
harbor-hf status
```

The CLI uses the active Hugging Face login only to authenticate HTTPS requests to the control API. It does not access the Bucket directly.

## Start a run

The control console starts a run from Terminal-Bench 2.1, `openai/gpt-oss-20b`, Inference Providers, OpenCode, and no extra reasoning by default. Dashboard harnesses that speak Chat Completions (OpenCode, Qwen Code, mini-swe-agent, Pi, Kimi Code, Hermes, OpenHands, OpenClaw, FX, and DeepSeek Harness) call the inference bridge inside their physical trial Job. The Job receives only the dedicated inference credential required by its immutable deployment profile. Codex and Claude Code stay off that route because they need a native API the router path cannot preserve. The cost ceiling tracks twice the estimated reservation until you edit it. Submit locks those choices onto a run named `run-<model>-<harness>-<reasoning>-<runtime>-<id>`.

Console tables keep their headers visible while scrolling and provide a text filter under every column. Filters apply to the loaded page; clear them together with **Clear filters**. Run detail loads the complete logical benchmark task list in one request. Task detail shows every attempt's `job.launch` action and projected HF Job status, while marking the one valid selected result. Preparation uses one trusted Job for the Run. Execution launches one physical Job for each logical trial attempt, so an infrastructure replacement adds another Job for the same task.
Launch-policy execution reservations apply to each physical trial Job. Preparation reservations apply to each permitted preparation attempt.

The trusted, digest-pinned deployment Job image is the worker boundary. The
digest-pinned benchmark image remains task data and never supplies the physical
Job bootstrap. Each worker validates the scoped Run and action identity, fetches
only its assigned projection-validated prepared trial, checks its Python-origin
Harbor lock digest and image binding, and executes Harbor once. It rejects
separate verifier images and uploads a canonical evidence manifest for
failures; the controller alone decides whether to launch a replacement Job.

The CLI submits the same lock through promoted profile aliases:

```bash
harbor-hf run submit \
  --benchmark <benchmark-profile> \
  --model <model-profile> \
  --harness <harness-profile> \
  --deployment <deployment-profile> \
  --launch-policy <launch-policy-profile> \
  --ceiling-microusd 5000000 \
  --yes
```

`5000000` micro-USD is a $5 run ceiling. Use an idempotency key when a caller may repeat the same request:

```bash
harbor-hf run submit \
  --benchmark <benchmark-profile> \
  --model <model-profile> \
  --harness <harness-profile> \
  --ceiling-microusd 5000000 \
  --idempotency-key <stable-request-key> \
  --yes
```

Repeating that command with the same actor and key adopts the existing run. It does not create a second logical run.

Harbor `harbor_job` fields on a benchmark profile are forwarded into the preparation lock. Diagnostic canary and replacement profiles set `agent_timeout_multiplier` to 4 so the agent gets one hour on the 900-second Terminal-Bench tasks. Official five-trial profiles keep Harbor's published timeouts. A sealed `benchmark_timeout` cannot be retried; submit a new run with a new idempotency key.

## Monitor work and results

```bash
harbor-hf run list
harbor-hf run status <run-id>
harbor-hf jobs
harbor-hf endpoints
harbor-hf results
harbor-hf audit
harbor-hf capacity
```

The shared namespace Job cap limits how many physical Jobs can run at once across runs. It defaults to 16. Update it through the control API without changing a locked run's per-run `max_jobs`. The idempotency key is durable: the same key and payload adopt the first update, while a different payload conflicts.

```bash
curl -X POST "$HARBOR_HF_CONTROL_URL/api/v1/capacity" \
  -H "content-type: application/json" \
  -H "idempotency-key: <stable-request-key>" \
  -d '{"max_active_jobs":128,"confirmed":true}'
```

The same information is available in the Space's web console. Dotted labels show a hover explanation of that control. Logical task outcomes use full phrases (scored success, provider rejected the request, agent ended without a score) instead of the raw `complete`, `policy`, and `agent` tokens. The Jobs page shows the latest observed state and recorded hardware cost for each HF Job and links the Job ID to its Hub inspect page. Execution Job logs stream Harbor trial stdout as the trial runs. Execution workers install Harbor from a pinned git commit so new harnesses can be evaluated before a PyPI release. The Results list shows pass rate, primary metric, and token cost. Open a result for the Wilson 95% CI, publication identity, and the Hub link to the Bucket prefix that holds the generated objects. Eligible final, clean, fully scored catalogs are also written as a SQLite snapshot under `results/schema=v1/leaderboard/` in the Bucket. Diagnostic and incomplete catalogs stay off that snapshot. The Space home page is that public leaderboard: it ranks configurations by score then cost and plots the Pareto frontier of observed spend versus primary metric. One left navigation lists Leaderboard and Admin. Admin contains Overview, Runs, Jobs, Endpoints, Results, Profiles, and Audit. Clicking an Admin view starts Hugging Face login when there is no session; the sidebar has no persistent sign-in or account-details prompt. Login waits for runtime initialization, including the projected operator ACL, so a partial startup cannot misreport an authorized identity as denied. `/health/ready` stays reachable during a long rebuild and reports `initializing` until the complete runtime is ready. Run and task pages list the Jobs launched for that run. Observed run spend is the sum of recorded attempt receipts and Job hardware receipts. The browser uses same-origin API requests and never receives the Bucket credential.

## Repair infrastructure failures

Terminal benchmark outcomes stay sealed. Only a task recorded as an eligible infrastructure failure can receive a bounded replacement:

```bash
harbor-hf run retry-infrastructure <run-id> \
  --task <task-id> \
  --reason "transient infrastructure failure" \
  --yes

harbor-hf run retry-infrastructure <run-id> \
  --all-eligible \
  --reason "retry eligible infrastructure failures" \
  --yes
```

The run page has the same control: **Retry infrastructure failures**. It only queues replacement Jobs for eligible infrastructure outcomes, including an infrastructure seal that should not have closed the logical task. Scored misses and other sealed outcomes stay sealed. A retry is a Job on the existing run. The run list does not add a second row. Each replacement receipt names the `job.launch` action that produced it.

If a trial Job ends without a valid result, the control service records an infrastructure attempt and may launch one replacement Job for that task. The deployment profile's `max_infrastructure_attempts`, per-Run `max_jobs`, namespace Job capacity, start-rate policy, and cost ceiling bound replacements. A failed reconciliation cycle writes a structured error log and retries on the next cycle instead of stalling silently.

Pausing stops preparation and execution dispatch without discarding terminal Job evidence. A resume task limit selects the first unresolved tasks in locked order and carries that selection through preparation into execution. Resume preserves the failed Job as `prior_attempt`, and bulk infrastructure retry adopts one durable ordered command when the same idempotency key is replayed. Actual receipts remain durable if observed spend crosses the ceiling; the Run becomes budget-exceeded and cannot reserve more work or publish.

Cancellation also preserves existing evidence:

```bash
harbor-hf run cancel <run-id> --yes
```

A cancelling Run stays active until its selected physical Jobs have stopped and its open target tasks are sealed. A failed cancellation or a nonterminal remote observation remains pending and is retried without releasing Job capacity or budget. Task-scoped cancellation leaves unrelated tasks and Jobs running. Cancellation is rejected after publication starts.

Publication is independent of execution. A publication retry rebuilds deterministic result objects from sealed task receipts and does not rerun model work.

## Safety model

- Run locks contain exact profile identities, task IDs, and input digests.
- Worker receipts identify the durable action that authorized the attempt.
- Mutations require an authenticated operator, explicit confirmation, and an idempotency key.
- Browser mutations also require same-origin requests and a CSRF token.
- The Bucket is append-only at the application boundary. The disposable SQLite projection records each object's verified SHA-256 digest and Bucket listing identity, so later syncs detect same-key replacements without downloading unchanged objects.
- A prepared execution Job starts from the reviewed digest-pinned worker image, not the benchmark image. The root worker verifies and unpacks the locked benchmark OCI image, strips privilege-bearing filesystem metadata, and maps the rootfs to one dedicated high host UID/GID.
- The self-contained worker image includes pinned Python, Harbor, and Harbor-HF agent code. `setpriv` gives every task, agent, and shared verifier command real UID/GID 60000, empty supplementary groups, no capabilities, and `no_new_privs`. PRoot supplies only the unpacked filesystem view and fake task-image user identity. It is not the security boundary.
- Preflight requires `git`, `proot`, `setpriv`, `skopeo`, and `umoci`, an unused task UID/GID, no effective `CAP_SYS_PTRACE`, and successful root-file and root-process-environment denial probes. Unsupported isolation is replacement-eligible infrastructure.
- Only the root-owned bridge can read `HF_INFERENCE_TOKEN`. Task processes receive a loopback inference URL, provider-specific credential aliases, and the locked output-token limit. The bridge enforces the locked model, request size, output token, and concurrency limits, then records root-owned provider request and token totals. A harness that completes without positive trusted provider usage is replacement-eligible infrastructure, not a sealed semantic result.
- The worker repeatedly enumerates the dedicated UID, stops every matching process until the set is stable, kills all of them, and verifies none remain. This includes processes that call `setsid` or fork during cleanup. Root-owned direct file copies reject traversal, links, and special files while enforcing total-byte, per-file-byte, entry-count, and path-depth limits.
- A terminal logical task cannot run again. Infrastructure repair creates a new physical attempt only for the failed task.
- Endpoint cleanup is complete only after a pause record reports zero ready replicas.
- Result catalogs retain outcome, quality, role, task counts, metric units, and source digests.

## Reset Run data during cutover

The one-time reset tool deletes only reviewed Run-derived Bucket prefixes and
fails on every unknown path. It preserves benchmark bundles, profiles,
promotions, capacity policy, operator ACLs, and migration records. Normal
control startup does not require this destructive reset: the Run-native
projection ignores retired control trees while their objects remain in the
Bucket. The default reset mode only writes a local, secret-free manifest:

```bash
uv run python scripts/reset_run_data.py \
  --bucket "<namespace>/<artifact-bucket>" \
  --manifest run-data-reset-dry-run.json
```

Review the counts, byte totals, prefix histogram, unknown count,
`delete_key_digest`, and `preserve_identity_digest`. Preserved objects use their
Bucket Xet hash when available; dry-run downloads only preserved configuration
objects that need a SHA-256 fallback. Immediately before applying, confirm that
the control Space reports `write_mode=disabled` and that no HF Job is active.
Then use the delete digest from that fresh manifest:

```bash
uv run python -m json.tool run-data-reset-dry-run.json
```

```bash
uv run python scripts/reset_run_data.py \
  --bucket "<namespace>/<artifact-bucket>" \
  --apply \
  --yes \
  --expected-delete-digest "sha256:<delete-key-digest>" \
  --dry-run-manifest run-data-reset-dry-run.json \
  --verification-manifest run-data-reset-verification.json
```

Apply re-lists the whole Bucket immediately before deletion, deletes in bounded
batches, and re-lists again. Success requires every reviewed delete prefix to
be empty and every preserved key, size, and content identity to remain unchanged.
The final verification manifest stays local.

```bash
uv run python -m json.tool run-data-reset-verification.json
```

## Migrate preserved profiles during Run-native cutover

The one-time profile migration inventories only
`control/schema=v1/profiles/`. It converts legacy capacity limits from
Sandboxes to Jobs and converts legacy deployment Sandbox templates to
digest-pinned trial Job templates. It renames legacy Run-ceiling policy fields
and creates replacement promotions for changed profile identities.
Current-schema profiles and unrelated promotions keep their original bytes. The
tool does not access ACLs, Run data, Space configuration, credentials, or any
other Bucket prefix.

Keep control writes disabled and confirm that no HF Job is active. Create a
fresh local manifest with the reviewed worker image digest and source revision:

```bash
uv run python scripts/migrate_run_native_profiles.py \
  --bucket "<namespace>/<artifact-bucket>" \
  --job-image "<worker-image>@sha256:<digest>" \
  --worker-revision "<full-git-commit>" \
  --manifest run-native-profile-migration-dry-run.json
```

The manifest contains counts, content digests, and a one-way digest binding it
to the destination Bucket. It contains no Bucket ID, profile name, alias, or
record ID. Review its `plan_digest`, then apply that exact plan:

```bash
uv run python scripts/migrate_run_native_profiles.py \
  --bucket "<namespace>/<artifact-bucket>" \
  --job-image "<worker-image>@sha256:<digest>" \
  --worker-revision "<full-git-commit>" \
  --apply \
  --yes \
  --expected-plan-digest "sha256:<plan-digest>" \
  --dry-run-manifest run-native-profile-migration-dry-run.json \
  --verification-manifest run-native-profile-migration-verification.json
```

The installed Bucket API is not transactional. Apply therefore adds and verifies
replacement profile objects, active promotions, and historical promotions in
three separate phases before deleting superseded records. An interrupted partial
batch leaves a resumable state. Rerun the same apply command. Before any write,
the tool verifies every downloaded Xet identity and checks both complete
operation counts against the reviewed limit. Any destination mismatch,
unreviewed content, path collision, concurrent inventory change, or malformed
record aborts the migration.

The [control service specification](docs/CONTROL_SERVICE.md) defines the durable record protocol, authentication boundary, recovery behavior, and deployment contract.

## Development

Clone the repository and install both locked environments:

```bash
git clone https://github.com/huggingface/harbor-hf.git
cd harbor-hf
uv sync --all-groups
npm ci
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local quality gates.

## License

[Apache-2.0](LICENSE)
