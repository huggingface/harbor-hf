# Provider credential references

After separately approved deployment, operators manage nonsecret references in
Workbench. The canonical Bucket registry is the sole authority; the app never
accepts or stores key values. No manifest path, offline hashes, hand-authored model
allowlist or worker digest is needed.

## Register → select → review → approve → setup → launch

1. Open **Manage secrets** in Workbench. Register the existing Space secret **name**
   (for example `MY_SECRET_KEY`), a friendly label and a change reason. Do not paste
   a key. Registration is allowed before the key exists. Provisioning or moving
   the actual credential is a separate explicitly approved operation.
2. Add an environment destination such as `DEEPSEEK_API_KEY`, choose **Secret
   (model_api_key)** and select the registered reference by label. The legacy HF
   choice retains saved HF behavior; a registered choice never falls back to it.
   One credential per run is supported, including multiple destinations of that key.
3. With the native starter, enter the exact harness model `deepseek.deepseek-flash`.
   The harness owns routing. Native key-only use sends `base_url: null` and
   `allowed_hosts: []`; no base URL is required. Advanced connection settings are
   optional for native use and explicit for other protocols. Declared hosts are
   review metadata, not firewall enforcement.
4. Click **Review credential use**. Inspect the server-derived exact recipe,
   model, worker image, digest, destinations and presence. Presence means only
   configured/missing, never authentication, quota or compatibility. Check the
   explicit confirmation, supply a reason, then **Approve credential use**. The
   ephemeral `review_id` is not persisted in browser drafts. Recipe, model,
   connection or registry changes invalidate review and confirmation.
5. Run the existing standalone setup test, then use the existing launch review
   and confirmation. Setup is credential-free and success is not approval.

Disable or re-enable a reference in Manage secrets with a reason. All writes use
`expected_revision`; ownership and grants are enforced server-side. On conflict,
refresh and inspect current state before reviewing again. On 503 or network loss,
assume the save may have succeeded: refresh and inspect, never automatically retry.
Registry polling invalidates stale reviews, including presence changes.

Names and reviews are operator-only, no-store data, not public-page or URL data.
Only opaque references appear in recipes. No new key-value storage or authority is
introduced. The adapter rechecks the exact grant at dispatch and restart; missing
or disabled selected credentials deny admission without legacy HF fallback.
Already running workers are not remotely revoked by disabling a reference.

## Native agent preset connections

A native agent preset can use the same reviewed connection. The subject of the
grant is then the preset identity, the agent slug plus its version, instead of a
Workbench recipe digest. The grant holds the exact base URL, the declared hosts,
the native wire API style, the single model and the fixed key destination
`OPENAI_API_KEY`.

A run submission selects that connection explicitly. It names the reviewed
reference and the native wire API style in `model.connection` and
`model.model_api`, and it names no Hub provider. A submission that names both a
provider and a connection, a connection without a wire API style, or a wire API
style without a connection is refused before any run record is written. A
submission that names no connection keeps the ordinary router route, so approving
a credential never changes where an otherwise identical submission runs.

For agents that accept Harbor's `model_api` option, the built record carries the
approved value. For example, `pi` writes it into the `api` field of its
`models.json`. Admission checks that value again at each start.

Harbor's ACP agent does not accept `model_api`. A reviewed ACP source configures
its own client. The submission must still name the API style approved by the
grant, but the built record does not add an unsupported ACP option. At each start,
admission requires exactly one matching grant for the agent import path and
version, model, operator, worker image and credential reference. It refuses an
ambiguous grant or an ACP record with an injected `model_api` option. The
separate source allowlist checks the pinned executable source.

The run record uses `openai/<model>`, the reviewed base URL and an opaque key
reference. Admission checks the URL and hosts again at each start. A connection
without an approved grant for the exact subject is denied; the run cannot fall
back to the router.

## Deployment caveat

This local implementation does not authorize deployment, credential movement or
execution. Align the existing live two-secret inventory and control-only token
instructions under separate explicit deployment approval before activation.

## Harbor boundary

Checked `src/harbor/utils/env.py` and `src/harbor/models/trial/config.py` at pin
`dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`, with locally cached upstream history.
Harbor owns environment resolution and execution; this UI uses existing control
routes and adds no resolver or JobConfig field. Standalone setup is secret-free;
authorized benchmark agent environment covers benchmark setup and run.

## Local integration validation (2026-09-10)

- 1,277 unit tests, 68 mocked browser tests, 100 root Python tests and 197
  agent-package tests pass after integrating main's task-working-directory,
  Sandbox-name and preset changes. Native key-only tests cover two model strings
  and two non-default task directories; legacy partial connections still fail.
- Root and agent formatting, lint, types, build, dependency tree, npm/Python
  audits, privacy and normal Slophammer check/DRY pass. Lint retains warnings.
  Authoritative contracts, OpenAPI and browser types were regenerated and staged;
  the normal generated-diff gate now passes.
- Root Python coverage passes at 89.10%. Supplementary global TypeScript coverage
  still fails 85%: lines 84.01%, statements 82.05%, functions 83.75%, branches
  76.69%. Supplementary agent-package coverage fails at 66.26%. All tests pass;
  no coverage threshold was weakened.
- The optional `slophammer-baseline.json` and `scripts/check_mutation.py` remain
  absent; the requested baseline and mutation commands were attempted and fail.
- Both control and parent-worker Docker images build locally. Offline checks of
  their immutable local image IDs confirm the pinned Harbor revision and exact
  integrated CommandAgent/Sandbox source. No image publication is implied.
- Browser checks passed on an isolated, explicitly started local Vite server
  after the initial automatic-server check stalled probing an unopened port.
- The feature is committed locally; the resolved integration is staged for
  parent review, not merge-committed. No push, PR, deployment, real secret input,
  credential transfer, hosted delivery or provider authentication was performed.

## Exclusive control authority

The registry queue serializes registration, status changes, review, approval,
submission admission and dispatch (including restart) within one runtime. The
queue is held through selected credential delivery. Revision checks and readback
are not distributed CAS: two controller instances sharing the Bucket are
unsupported. Operate exactly one write authority; stop the old authority before
starting its replacement. Do not use rolling overlap. Read-only non-authorities
must not run reconciliation or mutate the registry during startup. Initialization
only rebuilds local projections; it does not bootstrap or rewrite the registry.
No distributed lock, second controller, or additional store is introduced.

For reviewed provider bindings, `chat-completions` and `responses` require both
an explicit non-null reviewed base URL and a `model_base_url` run binding.
Only `native` permits key-only/null-URL connections. Admission and restart check
the same constraints; an ambient URL is never an approved substitute. Legacy HF
recipes and the separate control-token deployment hold are unchanged.

A preset-subject grant is the same kind of reviewed binding: it always needs a
non-null base URL, its hosts, one native wire API style and one model, and it
fixes the key destination. A preset grant without a base URL or with another
destination is rejected. The wire API field follows the subject: a preset grant
that carries the recipe `route_api` vocabulary is rejected, and a recipe grant
that carries the native `model_api` value is rejected.
