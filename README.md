<p align="center">
  <img alt="harbor-hf" src="assets/harbor-hf-logo.svg" width="440">
</p>

`harbor-hf` is a Harbor control plane for running benchmark campaigns on Hugging Face infrastructure. It submits pinned work to HF Jobs, tracks retries and Endpoints, preserves evidence in an HF Bucket, and publishes queryable results without running the benchmark on your machine.

A hosted installation uses two private resources: one control Space and one Bucket. The Space serves the API and web console while its single control process reconciles immutable records stored in the Bucket.

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

## Launch a campaign

A campaign selects promoted benchmark, model, harness, deployment, and launch-policy profiles. The control service resolves those aliases into an immutable campaign lock before creating physical work.

```bash
harbor-hf campaign submit \
  --benchmark <benchmark-profile> \
  --model <model-profile> \
  --harness <harness-profile> \
  --deployment <deployment-profile> \
  --launch-policy <launch-policy-profile> \
  --ceiling-microusd 5000000 \
  --yes
```

`5000000` micro-USD is a $5 campaign ceiling. Use an idempotency key when a caller may repeat the same request:

```bash
harbor-hf campaign submit \
  --benchmark <benchmark-profile> \
  --model <model-profile> \
  --harness <harness-profile> \
  --ceiling-microusd 5000000 \
  --idempotency-key <stable-request-key> \
  --yes
```

Repeating that command with the same actor and key adopts the existing campaign. It does not create a second logical run.

## Monitor work and results

```bash
harbor-hf campaign list
harbor-hf campaign status <campaign-id>
harbor-hf jobs
harbor-hf endpoints
harbor-hf results
harbor-hf audit
```

The same information is available in the Space's web console. The browser uses same-origin API requests and never receives the Bucket credential.

## Repair infrastructure failures

Terminal benchmark outcomes stay sealed. Only a task recorded as an eligible infrastructure failure can receive a bounded replacement:

```bash
harbor-hf campaign retry-infrastructure <campaign-id> \
  --task <task-id> \
  --reason "transient infrastructure failure" \
  --yes
```

Cancellation also preserves existing evidence:

```bash
harbor-hf campaign cancel <campaign-id> --yes
```

Publication is independent of execution. A publication retry rebuilds deterministic result objects from sealed task receipts and does not rerun model work.

## Safety model

- Campaign locks contain exact profile identities, task IDs, and input digests.
- Worker receipts identify the durable action that authorized the attempt.
- Mutations require an authenticated operator, explicit confirmation, and an idempotency key.
- Browser mutations also require same-origin requests and a CSRF token.
- The Bucket is append-only at the application boundary. A local SQLite database is only a disposable projection rebuilt from Bucket records.
- A terminal logical task cannot run again. Infrastructure repair creates a new physical attempt only for the failed task.
- Endpoint cleanup is complete only after a pause record reports zero ready replicas.
- Result catalogs retain outcome, quality, role, task counts, metric units, and source digests.

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
