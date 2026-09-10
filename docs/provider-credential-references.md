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

## Local validation (2026-09-10)

- 1,176 unit tests and 68 mocked browser tests pass, including name-only
  registration, operator visibility, revision conflicts, uncertain saves,
  reactivation, recipe/model/poll invalidation and approval through setup/launch.
- Formatting, lint (existing warnings), types, build, npm dependency tree and
  audit pass; audit reports zero vulnerabilities. Privacy and Slophammer normal
  check/DRY pass. Generated outputs are byte-stable on regeneration; the normal
  git-diff generated gate remains nonzero because this worktree intentionally
  retains uncommitted generated backend/API changes.
- Existing global TypeScript coverage gates remain below 85%: lines 83.98%,
  statements 82.01%, functions 83.64%, branches 76.60%. The new management panel
  exceeds 85% in each metric. No threshold was weakened.
- The optional `slophammer-baseline.json` and `scripts/check_mutation.py` are
  absent; baseline and mutation commands cannot pass. Previously recorded
  supplementary Python agent-package coverage gaps remain unmeasured here:
  this UI work does not change Python, and prior Python changes are preserved.
- No commits, pushes, hosted operations, real secret inputs, or credential
  transfers were performed. No live provider authentication is claimed.

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
