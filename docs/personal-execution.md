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
3. For Jobs, private results or launching, leave the token field empty to use the
   signed-in OAuth credential, or supply a purpose-scoped **same-account override**.
   The Space requests `jobs` and `inference-api` scopes, subject to user consent.
   Bucket permissions are checked separately; the documented OAuth scope list does
   not establish Bucket coverage. Use an appropriately scoped override if needed.
   OAuth credentials are retained only in server memory, never SQLite or browser
   storage. Logout, token/session expiry, or restart removes access. After restart
   the login session can remain valid but execution requires signing in again.
   An invalid explicit override never falls back to OAuth or control credentials.
4. Verify the token and view your Jobs. Select a configured benchmark, agent,
   model and HF inference provider. Start with `two-task-canary`.
5. Preview the native config and its SHA-256. This performs no task resolution
   or execution. Obtain exact launch approval as described below.
6. Load the approval, review all its fields, explicitly accept credential
   delivery, cost-limit arrangements and cleanup limitations, then dispatch.
7. Use direct provider Job links for diagnosis/cancellation, bounded provider
   log snapshots, and private native artifact listings/previews.

The private results panel (also available inline in Workbench) lists the first
page of the caller's private Buckets. You can also enter a name and validate it,
or explicitly confirm creation of a private Bucket. Existing Buckets are never
changed to private automatically. Creation may incur storage charges and is not
automatically retried after failure. The last validated/created Bucket name is
remembered server-side for that authenticated subject; permissions and privacy
are rechecked on use. Listing and metadata checks do not prove upload permission.

**Workbench workflow:** signed-in users can start from Fast-Agent 0.10.19 or FX
0.0.6, edit an agents-only native fragment, and save immutable versions. Saved
versions appear under **My Workbench configurations** in the Personal agent
dropdown. Preset model routing is a default; explicit runtime overrides are applied
afterward. Commands and configuration-file provisioning remain versioned in the
saved agent kwargs. Local files are not uploaded implicitly.
Benchmark tasks, environment and retries remain owned by the benchmark catalog.
Other top-level fragment fields are rejected for execution, not silently ignored.

### Declared identity versus harness configuration

`submission.model.id` is a free-form **declared identity**, not a forced CLI model
string. `provider` can be entered manually (omission means `unspecified`), and an
optional `revision` records the model revision. HF provider lookup is only a hint.

An optional `submission.runtime` supplies explicit execution overrides:

```json
{
  "model_name": "hf.my-model-alias",
  "endpoint": "https://router.huggingface.co/v1",
  "credentials": "hf-inference",
  "environment": [
    { "name": "MY_SETTING", "value": "custom" },
    { "name": "OPENAI_API_KEY", "secret_ref": "hf-inference-token" }
  ]
}
```

The new UI requires an exact harness model string before preview; enter it manually
or use **Apply HF routing hints**. When `submission.runtime` is supplied, the API
requires `model_name`. It is passed unchanged, including harness-specific spellings
such as `hf.…` or `codexresponses.…`. Legacy API submissions without `runtime`
remain supported for a normal `org/model` identity plus provider, using the preset
route. Free-form declared identities require an explicit runtime model string.
Editing declared identity metadata does not rewrite the harness runtime.
Applying HF hints is an explicit UI action, not ongoing synchronization.

Non-secret environment entries override the named variables; in a command harness
they become literals in both setup and run clean environments. That includes
replacing a model-variable binding if explicitly requested. Credential references
are run-only; they do not add setup credential bindings.

Infrastructure variables, duplicate names and credentials in endpoint URLs are
rejected. Secret detection uses heuristics, not a universal secret scanner:
scripts, configuration-file contents and literal values must remain secret-free
even when validation accepts them. Only the `hf-inference-token` reference bound to
`OPENAI_API_KEY` is supported today, and HF credentials require the HF router.
Other providers' secrets are **not** supported by this change.
Validation checks known endpoint variables in the merged environment and command
phase literals for conflicts with the HF credential route. This is not proof of
network egress confinement: scripts or configuration can direct requests elsewhere.
An isolated command harness can instead select `credentials: "none"` and a
different HTTP(S) endpoint. Its implicit model credential bindings are removed,
and endpoint bindings become non-secret literals. The CLI must itself support
that anonymous route. This does not remove the HF credential needed by the parent
runner for Jobs and private Bucket access.

Before provider dispatch, admission immutably records the approved submission,
runner image, model declaration, explicit overrides, and effective native
JobConfig. **Recorded configuration** on a Job retrieves the owner's snapshot,
including invocation scripts/configuration-file provisioning and symbolic
credential references, never credential values. Older runs without these snapshots
cannot be reconstructed by this endpoint.

The setup context now includes declared model identity/revision as well as the
effective native configuration. Changing either invalidates an incompatible setup
receipt, even if the CLI model alias stays unchanged. Older receipts that predate
this identity binding require a new setup test before new benchmark admission.
These records support review; they do not independently attest which model served
requests and do not cause leaderboard publication.

**Test setup** saves the current draft as an immutable version and opens an inline
Workbench execution panel with that version and purpose **setup** selected. It does not immediately
spend money. After exact setup approval, the same dedicated runner invokes native
Harbor `install_only: true`, skipping agent task execution and verification.
Installation commands still execute and may access the network and supplied
credentials. Use **Check setup result** on the resulting Job to inspect the native
result and record a receipt only when every expected trial finished without errors.
Missing evidence, cancelled/failed Jobs, and incomplete results are not passes.

**Use for benchmark** snapshots any edits too. Saved-version benchmark admission
requires a passed setup receipt for the exact version, model, benchmark configuration,
runner image and hardware. Changing any of those invalidates the match. A setup pass
is only user-owned installation evidence, never benchmark success or independent
verification. The user controls the evidence Bucket; this is not an anti-tampering
attestation or leaderboard acceptance.

Administrators cannot list other users' configurations or setup receipts through
these APIs. Session CSRF and owner isolation apply even with control writes disabled.

**FX limitation:** the retained 0.0.6 starter uses Vercel's AI Gateway. It is
available for authoring and install-only testing, but FX benchmark dispatch is
rejected by the HF-only credential path. The service does not substitute an HF
token for a gateway key. A separately reviewed gateway credential/route integration
is still needed for FX benchmark execution.

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
- For a saved agent, `submission.harness` is
  `{ "agent": "workbench", "version": "sha256:<saved-version-digest>" }`, and
  `submission.model.reasoning_effort` is `saved`.
- `mode`: `setup` or `benchmark` (omitting it retains benchmark behavior).
  Saved-version benchmark approvals also require `setup_test_run_id` naming the
  matching passed setup Job's run ID. Setup can set `inference_limit_usd` to zero;
  the explicit total compute budget and runtime limits remain required.
- Immutable runner `image`, runner `hardware`.
- `credential_source` is `oauth-session` for delegated OAuth or
  `supplied-user-token` for an explicit override. Admission rejects a different
  source from the one approved.
- `runtime_seconds`, `job_timeout_seconds` (at least 120 seconds longer),
  `expires_at`.
- Positive `total_budget_usd` and `inference_limit_usd` within that budget.
- `native_config_sha256` returned by the preview for that same run ID and
  submission. Catalog changes invalidate approval.
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
`preview` does not require or transmit an execution token; other actions use the
session's OAuth credential or the explicit supplied-token header. Session CSRF
applies to both. Responses use `Cache-Control: no-store`.

| Action | Body |
| --- | --- |
| `identity`, `jobs`, `approval` | `{}` |
| `buckets` | `{}`; first page of own private Buckets only |
| `check-bucket` | `bucket`; validates private metadata access and remembers selection |
| `create-bucket` | `bucket`, `confirm: true`; creates privately and remembers selection |
| `configuration` | `run_id`; own immutable approved submission and effective native config |
| `preview` | `run_id`, catalog `submission` |
| `setup-result` | `run_id` for a previously dispatched setup owned by the caller |
| `logs` | `job_id` |
| `cancel` | `job_id`, `confirm: true` |
| `results` | `bucket`, `run_id` |
| `artifact` | `bucket`, `run_id`, relative `path` under that run |
| `launch` | approved `run_id`, returned `approval_sha256`, `confirm: true`, `accept_best_effort_cleanup_and_external_cost_limits: true` |

Preview additionally accepts `mode`. The existing HF bearer authentication can be used by API clients; the supplied
token must match that verified identity too. CLI OAuth remains unresolved.
Provider errors are deliberately replaced with fixed diagnostics to avoid
credential leakage. This path does not enable historical Run actions,
legacy Workbench setup routes, or reconciliation. Native install-only tests use the
personal dedicated-runner path instead of restoring that old setup worker.
