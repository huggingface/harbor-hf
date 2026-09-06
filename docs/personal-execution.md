# Personal execution wiring

The `/personal` page connects existing HF session authentication and preset
compilation to a dedicated HF Job, not a process in the Space. Ordinary verified
users receive personal access; `HARBOR_HF_ADMIN_USERNAMES` adds administrators by
verified HF username. Existing subject ACLs remain supported for compatibility.
Personal access does not grant access to historical control-owned runs.
Administrator status never bypasses the personal token identity check.

## User workflow

1. Sign in through the existing web OAuth flow.
2. Open **Personal execution**. Benchmark/agent selection, reasoning options,
   model-provider lookup and native configuration preview work with login alone.
   No execution token is needed for authoring.
3. For Jobs, private results or launching, supply a purpose-scoped user HF token.
   The token needs Jobs, inference, and access to the selected existing private
   Bucket. Identity-only OAuth is not execution delegation.
4. Verify the token and view your Jobs. Select a configured benchmark, agent,
   model and HF inference provider. Start with `two-task-canary`.
5. Preview the native config and its SHA-256. This performs no task resolution
   or execution. Obtain exact launch approval as described below.
6. Load the approval, review all its fields, explicitly accept credential
   delivery, cost-limit arrangements and cleanup limitations, then dispatch.
7. Use direct provider Job links for diagnosis/cancellation, bounded provider
   log snapshots, and private native artifact listings/previews.

**Workbench authoring:** any signed-in user can edit, save and load their own
immutable native configurations, including while control execution writes are
disabled. Administrators cannot list other users' saved configurations through
this interface. Session CSRF and owner isolation still apply. Workbench remote
setup tests and custom-config launch are not implemented; configured runs use
the separate approved Personal execution path.

The password field is page-memory-only, cleared on navigation/reload. Requests
carry `X-HF-User-Token`; sessions also use existing CSRF protection. No token is
written to control state, a configuration, command arguments or browser storage.
The SDK receives it only request-scoped. Dispatch supplies it as an encrypted
HF Job secret. The runner exposes that same user token to Harbor through
`HF_TOKEN` and `HF_INFERENCE_TOKEN`. Every permission travels with the token.
Job termination does not revoke or expire it. Control `HF_TOKEN` stays separate.
Use HTTPS for any hosted control interface.

Raw Harbor logs remain in private artifacts. Provider log snapshots do not
currently stream the live native Harbor console. Artifact previews are text,
limited to 256 KiB; the native evidence tree remains available in the Bucket.
Listings stop at 1,000 files. No evidence is automatically shared, assessed,
made public, or submitted to the leaderboard.

## Exact launch approval

No approval is configured by default. Set `HARBOR_HF_PERSONAL_APPROVAL_FILE`
only to a **private, operator-managed JSON file** after the user approves all
launch details. Do not commit that file or bake it into a public image.
Its schema is `approvalSchema` in `apps/control-api/src/personal.ts`:

- Unique `run_id`, verified `owner`, existing `results_bucket`.
- Exact catalog `submission` (benchmark, harness, model and per-trial allowance).
- Immutable runner `image`, runner `hardware`.
- `runtime_seconds`, `job_timeout_seconds` (at least 120 seconds longer),
  `expires_at`.
- Positive `total_budget_usd` and `inference_limit_usd` within that budget.
- `native_config_sha256` returned by the preview for that same run ID and
  submission. Catalog changes invalidate approval.
- `credential_source`: `supplied-user-token`.
- `credential_destinations`:
  `control-request,hf-job-secret,harbor,sandbox,agent,hf-inference,hf-bucket`.
- `deployment_scope`: `dedicated-user-owned-hf-job`.
- `cleanup`: `selected-parent-only;children-best-effort`.
- `limits_reviewed`: `true`.

These monetary values record approval, **not an implemented dollar meter or
automatic spending stop**. Before setting `limits_reviewed`, the operator must
review the actual runtime and inference limit mechanisms and their exposure
against the total budget. Do not treat a provider timeout or Sandbox idle
timeout as a total compute-plus-inference ceiling. The UI explicitly requires
acceptance of external cost-limit arrangements. No such review or paid launch
has been completed for this branch.

Use a single control-service writer with private durable control storage.
Before dispatch it writes a non-secret admission claim. Successful Job identity
is recorded afterwards. The approval is consumed even if the provider response
is lost; inspect your personal Jobs and exact runner labels rather than retry.
User confirmation includes the approval digest, so changing the approved image,
limits or other fields requires fresh consent. Claims persist across Space restart.
The existing Bucket adapter serializes
one process's writes but does not provide a distributed conditional-create
guarantee: multi-replica admission is unsupported.

No automatic retry, adoption, cancellation sweep or second scheduler exists.
Cancellation targets exactly the chosen Job in the verified user's namespace.
It cannot confirm child Sandbox cleanup. A failed final upload may leave partial
or missing evidence. Loss of the container before upload can lose local results.
Provider links and honest unresolved-resource reporting remain essential.

## API

All operations are authenticated `POST /api/v1/personal/<action>` requests.
`preview` does not require or transmit a supplied token; other actions require
the supplied-token header. Responses use `Cache-Control: no-store`.

| Action | Body |
| --- | --- |
| `identity`, `jobs`, `approval` | `{}` |
| `preview` | `run_id`, catalog `submission` |
| `logs` | `job_id` |
| `cancel` | `job_id`, `confirm: true` |
| `results` | `bucket`, `run_id` |
| `artifact` | `bucket`, `run_id`, relative `path` under that run |
| `launch` | approved `run_id`, returned `approval_sha256`, `confirm: true`, `accept_best_effort_cleanup_and_external_cost_limits: true` |

The existing HF bearer authentication can be used by API clients; the supplied
token must match that verified identity too. CLI OAuth remains unresolved.
Provider errors are deliberately replaced with fixed diagnostics to avoid
credential leakage. This path does not enable historical Run actions,
Workbench setup execution, or reconciliation.
