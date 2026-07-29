# Provider agent architecture

## Decision

Provider-backed agents run as external Harbor custom agents. Upstream Harbor is
an immutable dependency and is never patched, forked, monkeypatched, or rewritten
at runtime.

The first migration replaces every existing provider-agent path at once:

- Hermes.
- OpenClaw.
- OpenClaw with the Codex runtime.
- Pi.

All four agents are loaded through Harbor's supported `AgentConfig.import_path`
interface. After the migration, `harbor-hf` has no provider execution path that
depends on adding an agent to Harbor's enum, factory, or installed-agent tree.
There are no legacy aliases, fallback renderers, or parallel built-in-agent
paths.

Historical campaigns remain readable through their immutable locks and evidence.
They do not keep the superseded execution path alive for new work.

## Ownership

### Agent package

The agent implementations live in one installable Python distribution inside
the `harbor-hf` repository. They are external to Harbor, but they are versioned
and released with `harbor-hf`; no agent package lives in `shellbench-local` or a
separate repository.

```text
harbor-hf/
  packages/harbor-hf-agents/
    pyproject.toml
    src/harbor_hf_agents/
      hermes/
        agent.py
        config.py
        installer.py
        session.py
        trajectory.py
      openclaw/
        agent.py
        config.py
        session.py
        trajectory.py
      openclaw_codex/
        agent.py
        config.py
        session.py
        trajectory.py
      pi/
        agent.py
        config.py
        session.py
        trajectory.py
      support/
        hf_jobs_ingress.py
        redaction.py
```

The existing `remote.worker` source pin therefore fixes both orchestration code
and the complete custom-agent package. The package is dependency-free and is
layered into the separately pinned Harbor environment without changing Harbor's
source or lock file.

Each agent module owns its installation, configuration, invocation, session
export, and trajectory conversion. Agent modules do not import one another.
They may share only agent-neutral security and evidence utilities.

The package implements agents against Harbor's public custom-agent API. It must
not copy Harbor source, import underscored Harbor helpers, modify the Harbor
checkout, or rely on the caller's current directory or `PYTHONPATH`.

### `harbor-hf`

`harbor-hf` owns remote orchestration and the boundary between locked campaign
configuration and the selected custom agent:

- immutable source preparation;
- provider API and model routing;
- per-trial provider capabilities;
- HF Jobs ingress authentication;
- generic custom-agent selection;
- compatibility-bundle validation.
- evidence collection and publication with checksums.
- infrastructure-only retry classification.

Agent-specific behavior does not belong in `runs.py`, `wave_worker.py`, the
provider recorder, or the generic evidence assembler.

### Harbor

Harbor remains the unmodified benchmark engine. `harbor-hf` uses only its public
configuration and custom-agent import APIs, together with its execution,
result, and trajectory APIs.

## Existing schemas

This design does not introduce another execution contract or runtime manifest.
The existing records already cover the required identities:

| Existing record | Authority |
| --- | --- |
| `ExperimentSpec` | Requested execution policy and its agent, model, provider, and source. |
| `RunLock` and campaign locks | Immutable resolved configuration and source revisions. |
| `HarborExecutionRequest` | Exact Harbor job configuration and independent verification policy. |
| Harbor `result.json` | Observed agent and model identity, usage, rewards, and exceptions. |
| `HarborCompatibilityBundle` | Typed, checksummed compatibility view of Harbor output. |
| Trial evidence manifest | Required workspace, session, trajectory, judge evidence, and logs. |
| `private-artifacts.json` | Typed private artifact inventory. |
| `checksums.json` | Content integrity for retained execution evidence. |

The only manifest changes are fields needed to select a custom agent through the
existing `AgentProfile`:

- `import_path`: the Harbor custom-agent class; and
- `revision_kind: git` for an underlying agent pinned by a full Git commit.

The custom-agent implementation itself is already pinned by
`remote.worker.revision`. A Git agent revision must be a full commit. Package
agents continue to use exact numeric versions. `HarborVerificationPolicy`
records the expected import path in addition to the existing logical agent name
and version, so config drift is rejected before output is accepted.

These fields extend the current pre-release schema in place. They do not create
a second lock, manifest, or identity system.

## Generic agent registry

`harbor-hf` has one internal, declarative registry. It is ordinary Python data
that stays in-process and performs no remote code discovery.

Each entry declares only what generic orchestration must know:

- stable logical agent name;
- required provider API;
- allowed and required non-secret parameters;
- required trajectory schema;
- whether successful execution requires a native session; and
- the failure categories that are safe to retry as infrastructure.

The selected manifest supplies the custom-agent import path. The pinned
`remote.worker` source supplies its implementation. The registry validates that
selection; it does not render agent configuration.
Agent configuration rendering stays in the external agent package.

Generic consumers perform a registry lookup and fail closed when no definition
exists. They do not branch on `hermes`, `openclaw`, `openclaw-codex`, or `pi`.

## Execution flow

1. The manifest selects an agent profile, provider target, routed model, and
   custom agent import path.
2. Planning resolves the normal matrix cell and includes the import path,
   underlying agent revision, and pinned worker revision in the existing run and
   campaign digests.
3. The worker checks out upstream Harbor and `harbor-hf` at their full commits
   using the existing immutable source-preparation boundary.
4. The Harbor command layers
   `packages/harbor-hf-agents` from the pinned worker checkout into the pinned
   Harbor environment with `uv run --with`. It does not modify Harbor's lock or
   source tree.
5. The adapter writes Harbor `AgentConfig.import_path`, the locked model name,
   and the exact underlying agent revision.
6. Harbor imports the custom class through its public factory and runs the trial
   normally.
7. The agent writes its redacted native session and ATIF-v1.7 trajectory under
   Harbor's normal agent log directory.
8. The existing exporter validates Harbor's typed result and produces the
   compatibility bundle.
9. Generic evidence collection requires the locked trajectory schema and, when
   declared by the registry, at least one non-empty session JSONL.
10. Secret scanning, checksums, terminal markers, retry decisions, and
    publication follow the existing campaign pipeline.

A successful trial must match the locked import path, logical agent name,
reported agent revision, routed model identity, task digest, and evidence
requirements. Any missing or ambiguous identity fails closed.

## Secure HF Jobs ingress

The provider recorder holds the real upstream provider credential. Each physical
trial receives a revocable scoped route. Private HF Job ingress may require an
additional `HF_TOKEN` that must not be given to the benchmark agent.

The external agent package starts a root-owned loopback bridge through Harbor's
public root-execution API. The bridge:

- binds only to `127.0.0.1`.
- accepts only the provider API declared by the registry.
- injects the private HF Jobs ingress authorization upstream.
- rejects unexpected paths and oversized requests.
- strips client authorization headers.
- logs neither bodies nor headers.
- terminates after the trial.

The agent runs as the unprivileged sandbox user and receives only a localhost
URL and a non-secret placeholder key. It never receives `HF_TOKEN`, provider or
judge credentials, the scoped route URL, authorization headers, or secret files.

User separation is a launch invariant. A paid canary must prove that the bridge
and agent have different UIDs and that the agent cannot read the bridge process
environment. Failure to enforce that boundary blocks the campaign. Redaction
cannot substitute for isolation.

## Agent Requirements

### Hermes

Hermes is installed from commit
`cb06017b1d6e1b9ae0cb35f99a48ffa6bcbaa828`. The installer and source checkout
must be commit-addressed; mutable branches and installers fetched from `main`
are rejected.

The pinned implementation uses the Vincent-compatible settings:

- `hermes-cli` toolset.
- 90 turns.
- memory and user profile disabled.
- compression enabled with threshold `0.85`.
- local terminal backend with a 180-second timeout.
- delegation maximum 50.
- checkpoints disabled.
- yolo approval.

It exports the reported session ID with redaction, applies only the canonical
unambiguous fallback, and converts the native session to ATIF-v1.7, including
parallel tool calls, observations, model identity, and usage metrics.

The transport is explicitly the Hugging Face provider bridge using Chat
Completions. The evidence records Vincent's LiteLLM transport only as comparison
provenance.

### OpenClaw, OpenClaw Codex, and Pi

Each runtime receives its own custom-agent module and strict configuration model.
The modules preserve their native request protocol and evidence format:

Embedded OpenClaw uses Chat Completions. OpenClaw Codex uses Responses and
retains genuine Codex identity. Pi uses Chat Completions with its locked model
configuration.

The migration preserves model-required parameters such as Kimi `top_p: 0.95`
and embedded OpenClaw thinking `off`. One runtime's configuration, request
rewriting, or trajectory converter must never be reused to impersonate another.

## Evidence Rules

Artifact discovery is based on generic kinds and path predicates. Generic code
must not enumerate agent-specific session filenames. A non-empty JSONL under the
agent tree whose filename identifies it as a session is a session artifact; a
validated `trajectory.json` is a trajectory artifact.

The registry supplies the required trajectory schema and session requirement.
The agent-specific module is responsible for producing valid artifacts. Generic
validation checks identity and presence, checksum and size bounds, plus
redaction and secret absence.

No physical execution writes `_SUCCESS` until compatibility validation, required
artifact validation, checksum generation, provider-route revocation, and secret
scanning have completed.

## Failure Policy

The following are infrastructure failures and may receive a new physical
execution under the same logical trial:

- immutable source preparation failure.
- custom-agent package installation failure unrelated to its locked content.
- private ingress startup or authentication failure.
- provider transport failure covered by the locked retry policy.
- missing terminal evidence caused by worker or sandbox loss.
- artifact publication failure.

The following remain terminal agent or benchmark outcomes:

- a validly started agent exits unsuccessfully.
- the agent reaches its turn or time limit.
- the agent does not complete the task.
- a safety refusal occurs.
- the verifier rejects the workspace.

Evidence or identity ambiguity never becomes a success and never authorizes a
semantic rerun.

## Migration

This is a hard replacement for new provider campaigns:

1. Add the existing-schema `import_path` and Git-revision support plus the
   generic registry.
2. Add `uv --with` installation from the already pinned worker checkout.
3. Implement all four custom agents and neutral shared support under
   `packages/harbor-hf-agents`.
4. Migrate every provider campaign profile to its custom-agent `import_path`.
5. Remove name-based provider branches, built-in-agent assumptions, custom
   runtime-manifest work, exact session filename entries, and Harbor fork pins.
6. Run local contract and mutation tests.
7. Run one Fireworks and one Together paid canary for every applicable wire API
   and agent family.
8. Launch full campaigns only after all canaries pass.

No new provider campaign may use the old path after step 5. Historical evidence
remains readable but cannot select the removed writer.

## Verification matrix

Local validation must cover:

- import-path validation and worker-revision pinning;
- full-commit and exact-package revision enforcement;
- deterministic run and campaign digests;
- dependency-free `uv --with` installation without Harbor lock drift;
- custom-agent loading through unmodified Harbor;
- registry rejection of unknown agents and unsupported APIs;
- strict per-agent configuration validation;
- exact Hermes installation and configuration;
- session selection and redaction, including malformed-session rejection;
- ATIF-v1.7 conversion, including Unicode and parallel tools;
- model and agent identity drift;
- bridge path restrictions, request-size limits, authorization injection,
  process isolation;
- planted secrets anywhere in filenames or contents, including sessions,
  trajectories, logs;
- infrastructure-versus-agent failure categorization;
- provider checkpoint and terminal-marker ordering; and
- mutation tests for every fail-closed branch.

Paid canaries must retain and verify the Harbor result, compatibility bundle,
provider evidence, judge evidence, redacted session, ATIF trajectory, workspace,
checksums, source revisions, model identity, and a zero-finding secret scan.
