# Dedicated runner — local implementation, not launch-ready

This executable invokes the pinned native `harbor run` CLI and uploads its
native output tree, including failure artifacts, to an existing private user
Bucket. It does not implement task resolution, retries, a scheduler, Harbor Hub
sharing, or leaderboard ingestion. Historical API and control-service execution
guards remain in place. The separately gated personal path is described in
[personal execution](../../docs/personal-execution.md).
No paid launch or deployment is authorized by this file.

## Container contract

Build the CLI base using `deploy/parent-worker/Dockerfile`, then build this
Dockerfile with `HARBOR_HF_CLI_IMAGE` set to that image's immutable digest.
The runner takes a native JSON JobConfig at `/input/config.json`, or decodes it
from `HARBOR_HF_CONFIG_B64` supplied by dispatch. `/data/run` must not already
exist. Do not put credentials in that config.

Required environment:

- `HARBOR_HF_OWNER`: verified personal HF username.
- `HARBOR_HF_RESULTS_BUCKET`: existing Bucket name, without namespace.
- `HARBOR_HF_RUN_ID`: unique, admission-assigned run identifier.
- `HARBOR_HF_RUNTIME_SECONDS`: positive Harbor runtime allowance.
- `HARBOR_HF_USER_TOKEN`: explicitly supplied user token, delivered as an HF
  Job secret, never as an argument or image build input.

The runner verifies token identity and Bucket privacy with public SDK methods.
It passes only that user token as `HF_TOKEN` and `HF_INFERENCE_TOKEN` to Harbor,
matching the existing preset compiler's environment references. The Space control
credential must never reach this container. Every permission on the supplied
token is available in the runner, and wherever Harbor forwards it. Job secrets
do not imply automatic token expiry or revocation.

Raw Harbor output is retained locally, not streamed to provider logs. Before
upload, links, special files, and literal supplied-token leaks cause upload to
be withheld. This does not detect transformed secrets or all sensitive content.
Artifacts stay private. The destination is
`hf://buckets/<namespace>/<bucket>/runs/<run-id>`; uploads do not delete other objects.
Privacy is checked again immediately before upload, not atomically throughout
the transfer. Result-publication plugins are rejected.

## Remaining integration and limitations

- Dispatch, request-scoped supplied-token transport, personal Jobs/logs/results
  UI, and exact single-use admission approval are wired through `/personal`.
  No live HF integration success is claimed from offline tests.
- Admission must bind a unique run ID, configured benchmark/agent, immutable
  runner image, approved credential destinations and numerical spending budget.
  This entrypoint is not a safe endpoint for arbitrary user configurations.
- This increment accepts only the HF user token; additional inference-provider
  credentials need explicit destination approval and implementation.
- Workbench saved agents are composed with catalog benchmark settings. Setup uses
  native `install_only: true` through this same runner, not a separate setup worker.
  Matching user-owned setup evidence is required for saved-version benchmark
  admission; it is not independent verification. Fast-Agent 0.10.19 is the authoring
  starter. FX's gateway-based benchmark route is not supported by HF-only credentials.
- No published runner image or live paid setup/benchmark canary is claimed by this
  UI integration. A digest-pinned image and separate exact approvals are prerequisites.
- Set a provider Job timeout allowing Harbor runtime plus shutdown/upload time.
  Neither timeout is a dollar ceiling or an inference spending limit.
- SIGTERM or runtime expiry requests local graceful shutdown, then kills the
  local process group after 30 seconds. This never proves remote Sandbox
  termination. No unrelated Jobs are searched for or cancelled.
- Upload occurs after CLI exit. SIGKILL, container loss, disk exhaustion, upload
  failure, or provider hard timeout can lose artifacts. Failed transfers may be
  partial. No periodic checkpointing or automatic retry is claimed.
- Space-restart survival follows from the proposed independent Job architecture,
  but has not been integration-tested here.

Public-source recheck: Harbor issue #3082 is closed and Hub issue #4812 open.
Current Harbor main still creates Sandbox with image, flavor, idle timeout and
token-forwarding choice only. Public HF APIs support runner creation labels and
post-creation replacement of labels; no private-handle interception is used.
Harbor `--launch`, `--upload`, and sharing options target Harbor Hub and are not
used as substitutes for user-owned HF Jobs or private Bucket persistence.
