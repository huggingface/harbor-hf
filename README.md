<p align="center">
  <img alt="harbor-hf" src="assets/harbor-hf-logo.svg" width="440">
</p>

`harbor-hf` is a Harbor companion CLI for running benchmark campaigns on
Hugging Face infrastructure. It takes an experiment manifest describing a
matrix of models, deployments, and agents, executes every cell remotely on HF
Jobs, Inference Endpoints, and Sandboxes, and publishes verified, queryable
result tables — without loading a model or running a task on your machine.

Three properties hold across every run:

- **Nothing mutable executes.** Manifests pin exact commits for code, models,
  and benchmarks, SHA-256 digests for images, and content digests for every
  task. Anything less is rejected before submission.
- **No endpoint outlives its work.** An independent watchdog Job holds a
  compare-and-swap lease on every Inference Endpoint and pauses it if the
  controller dies. Success is declared only after the endpoint is verified
  paused with zero ready replicas.
- **Evidence before results.** Sessions, logs, verifier output, and checksums
  are redacted, validated, and archived to a private HF Bucket before a run can
  publish. Published tables always trace back to canonical evidence.

## Browse Results

The public [Harbor Results Space](https://huggingface.co/spaces/osolmaz/harbor-results)
compares final benchmark evaluations and exposes stable campaign, run, trial,
and execution URLs. It serves only sanitized normalized tables and artifact
metadata; complete sessions and canonical evidence stay in the private HF
Bucket.

## Setup

Requires Python 3.12+. Install the CLI from PyPI with
[uv](https://docs.astral.sh/uv/):

```bash
uv tool install harbor-hf
```

For development, clone the repository and install the locked environment:

```bash
git clone https://github.com/huggingface/harbor-hf.git
cd harbor-hf
uv sync
```

Local operator actions authenticate through your active Hugging Face login
(`hf auth login`, or set `HF_TOKEN`). The account needs access to HF Jobs,
Inference Endpoints, and Buckets in the target namespace. On first submission,
`harbor-hf` creates a private `harbor-hf-coordination` Dataset in the
namespace to hold campaign state, and verifies that it and the artifact
Buckets are private before doing any work.

A remote Job uses a separate purpose-scoped token. Add it to Harbor HF once:

```bash
uv run harbor-hf auth add-job-token harbor-hf-job
uv run harbor-hf auth status
```

`add-job-token` asks for approval, reads the token through a hidden prompt,
verifies that it is fine-grained, stores it in Harbor HF's private local token
file, and selects it for future Jobs. The token file defaults to
`~/.config/harbor-hf/stored_tokens`; its directory is `0700` and the file is
`0600`. Like the HF CLI's token store, this is a plaintext file protected by
local filesystem permissions. Harbor HF's JSON config stores only the selected
name. Set `HARBOR_HF_TOKEN_STORE` or `HARBOR_HF_CONFIG` to override their paths.
Use `auth tokens`, `auth use-job-token`, and `auth remove-job-token` to manage
saved entries. See the [local token store](docs/token-store.md) for the full
format and validation rules.
`HARBOR_HF_JOB_TOKEN` remains an explicit per-process override. Harbor HF never
reads the Hugging Face CLI token store, the active `HF_TOKEN` login, or the
output of `hf auth token` for a remote Job.

## Plan an Experiment

Start from [the ShellBench example](examples/shellbench.yaml), replace its
placeholder revisions and destinations, then validate and resolve it:

```bash
uv run harbor-hf validate experiment.yaml
uv run harbor-hf plan experiment.yaml
uv run harbor-hf campaign plan experiment.yaml
```

Planning is entirely local. `plan` prints the resolved matrix cells and the
experiment digest; `campaign plan` resolves the same manifest into
deterministic, content-addressed runs, shards, and trials. The manifest format
is defined in the [run specification](docs/run-spec.md), and
`campaign schema` exports the plan and lock JSON Schemas.

To reproduce the public ShellBench trace methodology, use the
[six-run example](examples/shellbench-public-six-run.yaml). It sets
`execution.attempts: 6`, producing six fresh logical trials per task while
keeping infrastructure retries separate. Report mean reward, strict trial pass
rate, and each task's 0–6 pass count. Do not use an any-of-six result as the
headline score.

## Run a Campaign

```bash
uv run harbor-hf campaign submit experiment.yaml
uv run harbor-hf campaign status CAMPAIGN_ID --namespace NAMESPACE
```

For an Inference Provider campaign, `submit` stores one immutable input package
and launches one detached controller Job. The controller runs each bounded wave
inside its own process, commits trial evidence as work finishes, and publishes
the result. A namespace-level claim serializes internal waves that share one
provider service. It does not need a local reconciliation loop or child wave
Jobs.

Endpoint-backed campaigns keep their separate endpoint safety path. Operators
can inspect either campaign with `campaign reconcile --dry-run`. An applied
reconcile is available only for endpoint campaigns. The current CLI never
creates a provider wave Job; historical provider campaigns remain tied to their
pinned Harbor HF revision.

Install one shared recovery watchdog for an approved campaign list:

```bash
uv run harbor-hf automation install automation.yaml --schedule "<cron>" \
  --campaign-id CAMPAIGN_ID
```

Repeat `--campaign-id` for each approved campaign. The scheduled Job checks
controller heartbeats and exact Job labels. It starts a sequential replacement
only after the prior Job is terminal, the claim is stale, the durable checkpoint
verifies, and the locked attempt and spend limits permit recovery. Capacity and
policy pauses always require an operator decision.

Operate a running campaign with:

```bash
uv run harbor-hf campaign cancel CAMPAIGN_ID --namespace NAMESPACE
uv run harbor-hf campaign retry CAMPAIGN_ID --shard SHARD_ID --namespace NAMESPACE
uv run harbor-hf campaign resume CAMPAIGN_ID --namespace NAMESPACE --cleanup-verified
uv run harbor-hf campaign seal CAMPAIGN_ID --namespace NAMESPACE
```

`cancel` records a durable cancellation and drains work; `retry` requests an
immediate retry for a shard's retryable trials; `resume` records that an
operator verified endpoint cleanup after a manual-intervention stop; `seal`
closes out a drained partial campaign by recording its failed retries as
zero-score outcomes. The
[Harbor Cookbook](docs/harbor-cookbook.md) walks through full campaign
operation end to end.

### Ask your coding agent

Copy this block when you want an agent to plan or operate a campaign.

```text
Use Harbor HF to plan or operate this benchmark campaign.

Start with this skill before changing files or creating remote work:
https://raw.githubusercontent.com/huggingface/harbor-hf/main/skills/harbor-hf/SKILL.md

Follow the skill and its linked source documents. Run the duration and spend
gates before paid work. Ask me for missing protocol choices and explicit
authorization for remote writes.
```

## Publish Results

```bash
uv run harbor-hf artifacts verify CAMPAIGN_ID --namespace NAMESPACE
uv run harbor-hf results publish CAMPAIGN_ID --namespace NAMESPACE
uv run harbor-hf results publish-correction CORRECTION.yaml --namespace NAMESPACE
```

`artifacts verify` checks publishable run evidence against every declared
checksum. `results publish` verifies evidence again and writes normalized
Parquet tables to result and index Datasets with the explicit `private` or
`public` visibility locked by the manifest. Harbor HF fails when an existing
repository has different visibility and never changes privacy automatically.
`results catalog` records
append-only promote or withdraw decisions for a publication in the primary
catalog. The
[result publication contract](docs/result-publication.md) freezes the table
schemas, and the checked-in [JSON Schemas](schemas/) define the canonical
publication contract.

## Submit a Single Run

One resolved matrix cell can run outside a campaign:

```bash
uv run harbor-hf submit experiment.yaml --dry-run
uv run harbor-hf submit experiment.yaml
```

If a matrix dimension has more than one profile, select the cell explicitly
with `--model`, `--deployment`, or `--agent`. The Job writes its evidence
under `runs/<experiment>/<run-id>/` in the configured private Bucket and marks
it `_SUCCESS` or `_FAILED` only after endpoint cleanup is verified.

## Architecture

The [control service plan](docs/2026-08-16-harbor-hf-control-service-plan.md)
defines the next control architecture. It will replace live Git-backed
coordination with one private control Space and the existing evidence Bucket,
while consolidating new result publication into one existing Dataset. It also
sets a permanent resource rule: campaigns, repairs, profiles, leases, status
records, and result subsets must reuse canonical Hub resources instead of
creating new repositories or Buckets. Normal control uses one retained existing
Hugging Face service credential. Redundant service credentials are retired only
after a consumer audit and a canary using the retained credential.

The [architecture overview](docs/architecture.md) describes the current
execution and storage boundaries. Benchmark tasks come from content-addressed Harbor
packages, anonymously cloned commit-pinned public Git repositories, or
immutable private bundles built from local directories. The [benchmark source
specification](docs/benchmark-sources.md) defines those source forms and its
[implementation record](docs/benchmark-source-implementation-plan.md) describes
the bundle and credential-boundary work. Agents run in HF Sandboxes, models
serve from Inference Endpoints or Inference Providers, and all coordination
happens through parent-checked commits to the private coordination Dataset;
there is no server to keep alive. The
[endpoint provisioning contract](docs/endpoint-provisioning.md) documents
deterministic endpoint ownership. The
[deployment profiling contract](docs/deployment-profiling.md) defines the
powers-of-two concurrency method, immutable profile evidence, stopping rules,
and selection criteria used before a full campaign. The [provider-agent
architecture](docs/provider-agent-architecture.md) defines the unmodified-Harbor
custom-agent package used for Hermes, OpenClaw, OpenClaw Codex, and Pi. The
proposed [trial evidence bundle](docs/trial-evidence-bundle.md) and its [implementation
plan](docs/trial-evidence-implementation-plan.md) define complete post-agent
workspace capture and exact verifier-judge records.

## License

[Apache-2.0](LICENSE)
