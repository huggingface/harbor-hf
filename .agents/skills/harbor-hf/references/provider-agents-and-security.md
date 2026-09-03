# Harbor agents and security

## Supported boundary

Inference-backed harnesses run as Harbor agent plugins. Harbor loads the exact
plugin through `AgentConfig.import_path`, and the plugin configures its native
tool to call the resolved Hugging Face inference upstream directly.

Support requires:

- an exact package version or full Git commit;
- a declared native API;
- a model profile supporting that API;
- a deployment using the same API and matching provider suffix;
- strict agent arguments and environment handling;
- required session and trajectory behavior;
- process cleanup before verification; and
- shared failure classification.

Do not add request or response translation, a fallback model, or agent-name
branches in shared control and worker code.

## Revision and registry rules

The immutable harness profile names the plugin import path and native tool
revision. The worker revision identifies the containing agent package.

One neutral registry validates:

- logical agent name;
- import path and class;
- exact revision syntax;
- supported inference APIs;
- permitted keyword arguments;
- required environment values;
- native session selection;
- ATIF handling; and
- failure taxonomy.

Package revisions are exact numeric versions. Git revisions are full commits.
Mutable branches, tags, ranges, and unpinned installers are rejected.

## Direct inference configuration

The control service composes:

```text
model_name = openai/<model-id>:<inference-provider>
OPENAI_BASE_URL = <deployment inference_upstream>
OPENAI_API_KEY = ${HF_INFERENCE_TOKEN}
HARBOR_HF_MAX_OUTPUT_TOKENS = <locked positive integer>
HARBOR_HF_PROVIDER_TIMEOUT_SECONDS = <locked positive integer>
extra_allowed_hosts += <upstream hostname>
```

The plugin may add documented native aliases or generate a native config file.
It may derive the provider-facing model only by removing Harbor's first
provider prefix. It must not remove the inference-provider suffix or choose
another route.

Chat Completions and Responses are distinct. An incompatible model, harness,
or deployment is unsupported and must fail before launch.

## Credential boundary

The control Space retains `HF_TOKEN`; no Job receives it.

An execution Job receives `HF_INFERENCE_TOKEN` only when its immutable
deployment includes `inference_upstream`. Harbor expands the credential
reference in `AgentConfig.env`, and the reviewed agent is the intended
consumer. Preparation and no-inference Jobs receive no inference credential.

The execution Job separately receives a signed worker capability scoped to:

- one Run;
- one launch action;
- one task;
- declared evidence and receipt operations; and
- a short expiration.

Jobs have no writable canonical Bucket mount. The inference credential must not
appear in logs, sessions, trajectories, workspaces, manifests, or results.

Direct inference is not safe for arbitrary user-authored agent code using a
platform credential. Such recipes remain setup-only until their exact compiled
form and secret behavior are reviewed and promoted.

## Task and agent isolation

The reviewed worker:

- verifies the digest-pinned task image;
- bounds compressed and expanded image content;
- rejects unsafe paths and special files;
- strips elevated file metadata;
- runs task and agent commands as a dedicated real host UID;
- removes supplementary groups and capabilities;
- enables `no_new_privs`;
- keeps worker state and credential files outside the task rootfs; and
- stops agent descendants before freezing the workspace.

PRoot provides filesystem presentation and user emulation only; it is not the
security boundary. The agent and task share the task environment by design.

## Benchmark source credentials

Public Git benchmark sources resolve anonymously to a full commit. Private
benchmark support must use a separately approved content-addressed source
mechanism. Do not pass personal Git, Hub, or cloud credentials to a task.

The control credential must never be reused as a benchmark-source or inference
credential.

## Agent evidence

Retain profile-required evidence such as:

- plugin and native tool revisions;
- sanitized generated configuration;
- command timing and exit state;
- native session;
- ATIF trajectory;
- frozen workspace;
- Harbor result and verifier output; and
- source, image, and worker provenance.

Preserve usage exposed by Harbor's native result when available; otherwise
leave it unknown.

Scan known credential values and high-confidence patterns in path names and
file bytes. A finding invalidates the attempt. Do not print the match or rewrite
canonical evidence to conceal it.

## Trial-scoped replacements

Harbor internal retries remain disabled. Harbor-HF owns physical attempt
identity.

Another attempt is allowed only when:

- the latest outcome is typed replacement-eligible infrastructure;
- the exact prepared trial is reused;
- no attempt is active or ambiguously owned;
- the physical-attempt limit remains;
- the Run ceiling admits it; and
- no deterministic shared defect is present.

Agent failures, model behavior, benchmark timeouts, verifier outcomes, and
valid zeros are semantic and terminal.

## Judge isolation

When a benchmark requires a judge, keep judge identity and credentials
separate from task-model inference. Bind judge evidence to the exact task,
frozen workspace or answer, policy, selected exchange, and verifier result.

Do not expose judge credentials to the agent or task. Do not retain
authorization headers or cookies in judge evidence.

## Verification matrix

Before remote use, test:

- import path and exact revision;
- model provider-suffix and API compatibility;
- direct environment resolution;
- missing and malformed setting rejection;
- upstream host allowlisting;
- preparation and no-inference credential absence;
- native configuration precedence;
- install-time versus runtime environment cleanup;
- real-UID task execution;
- agent descendant cleanup before verification;
- session discovery, redaction, and malformed-session rejection;
- ATIF conversion;
- planted credentials in paths and bytes;
- identity and lock drift;
- semantic versus infrastructure classification; and
- deterministic cleanup after success and failure.

## Security failure response

Stop immediately when:

- a credential or capability appears in evidence or logs;
- a Job receives the control credential or writable Bucket access;
- a no-inference or preparation Job receives the inference credential;
- model, provider, API, upstream, or allowed-host values drift;
- an unreviewed agent receives a platform credential;
- agent descendants survive into verification;
- task UID or privilege checks fail; or
- evidence scanning or checksum validation is incomplete.

Preserve non-secret diagnostic facts, quarantine affected evidence, prevent
publication, stop affected work, and request an operator decision. Credential
rotation or public-history rewriting requires explicit approval.
