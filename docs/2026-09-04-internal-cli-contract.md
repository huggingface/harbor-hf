# Internal control-Space CLI contract

Status: reviewed local design and offline boundary regressions; **not an executable
integration**. This document does not amend the execution-disabled policy or grant
remote operations. The authorization is the internal design/local compatibility
amendment in `projects/huggingface/harbor-hf.md`.

## Decision and useful local scope

Keep the existing TypeScript service as the sole control authority. A future
Harbor CLI child inside `<control-space>` could retain the Jobs credential inside
the Space, unlike the withdrawn parent Job. This is a candidate placement, not
proof of safe execution: imported agents, verifiers, environment implementations,
and job plugins execute Python in the controller process. Arbitrary customer code
cannot run there with either secret accessible.

Keep current native configuration authoring. Protect its separation from execution
with tests of the actual API and service, not a new planner, noop launch adapter,
process runner, or parallel reconciler. Existing rejection already covers every
execution request, so no additional runtime guard is necessary in this phase.
Do not interpret schema-valid, saved, or previewed configuration as reviewed code.

## Source review (2026-09-04)

Pinned Harbor: `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`. Fresh public main observed:
`5c364a538e0af19eb58a53fdb895d7c0f974cef5` (later than the earlier `477c2759`
research observation). No pin upgrade was made.

Checked pinned files and compared their subsequent history:

| Files / public surface | Finding |
| --- | --- |
| `src/harbor/cli/main.py`, `cli/jobs.py` | `harbor run --config PATH` is an alias for job start. `--print-config` exits before `Job.create`; it emits configuration, not a resolved task lock. `--dry-run` requires managed `--launch`, not isolated preparation for this integration. These files are unchanged at the observed main. |
| `src/harbor/cli/agents.py`, `agents/factory.py` | Both `harbor agents list --json` and `harbor agents schema NAME --json` exist at the pin. Schema lookup resolves an agent class, including import selectors; it is not safe discovery for untrusted names in a secret-bearing process. |
| `src/harbor/cli/job_plugins.py`, `models/job/config.py` | CLI `--plugin` loads controller-side hooks. `JobConfig.plugins` is deprecated and ignored, not a supported isolation mechanism. Do not add it or translate arbitrary config into CLI arguments. |
| `src/harbor/environments/hf_sandbox.py` | `Sandbox.create(image, flavor, idle_timeout, forward_hf_token)` receives neither trial/session identity nor caller ownership labels. `forward_hf_token` defaults false. `job_timeout` controls idle shutdown, not a hard wall-clock stop. File unchanged at observed main. |
| `src/harbor/models/job/lock.py`, `models/job/result.py`, `models/trial/config.py`, `models/trial/result.py`, `job.py` | Native config, task resolution, job/trial locks, results, concurrency, retry and resume remain Harbor-owned. Native artifacts do not expose HF Sandbox Job IDs sufficient for ownership recovery. No replacement result or task format is justified. |
| `src/harbor/agents/installed/base.py`, `installed/pi.py`, `installed/codex.py` | Reviewed installation methods dispatch commands through `environment.exec`/`exec_as_agent`/`exec_as_root`, i.e. into the Sandbox, not a host shell. Their Python class construction and model-connection logic still execute in the controller. This is not a complete code/security attestation for these agents. |

Fresh main adds sensitive-command redaction in installed-agent base via
`5c364a53` (completion options change). That useful change does not solve isolated
preparation or ownership. Relevant CLI/config/lock/Sandbox surfaces remain unchanged;
there is no reason to upgrade blindly or claim the new pin safe. Codex reasoning
choices also changed after the pin (`49df1f8a`, `3e39b472`: replace `ultra` with
`max`, add `none`). The offline fixture uses `low`, accepted at the current pin;
future option discovery must remain revision-bound rather than silently adopting
new choices.

Also read public Hub SDK `_sandbox.py` at `deb97775`: `Sandbox.create` accepts
`namespace`, but no caller `name` or `labels`; it writes internal Sandbox labels
and uses a 24-hour Job timeout. Listing an account's Sandboxes does not identify
which Run owns them. A pool name is not a dedicated Sandbox ownership API.
Default personal namespace can be used in a future design; organization selection
can be deferred. Namespace support alone is therefore not the blocking gap.

## Threat model and input contract

Threat actors include a signed-in operator submitting hostile configuration, a
malicious task/image, a compromised agent dependency, and forged or stale provider
observations. Operator authentication is not code review or permission to expose
Space secrets. Prompt and task data are untrusted even with a reviewed agent.

| Boundary | Required rule |
| --- | --- |
| Browser/API to authoring | Existing versioned durable schema and generated pinned JobConfig schema remain authoritative. Reject credential material before saving; no secret-bearing preview or artifacts. Schema acceptance is structural, not native option validation or launch approval. |
| Authoring to future policy review | Restrict actual native fields using reviewed capability data. Do not build a hand validator mirroring Harbor, alias `environment.kwargs.flavor`, or branch core logic on harness/model/benchmark names. Unsupported open extension fields are rejected for execution rather than assumed harmless. |
| Policy review to CLI | Reject user plugins, module/path import selectors (including selectors hidden in `name`), custom environments/verifiers, host paths, source jobs, skills or controller hooks not covered by review. No caller-provided argv, shell, env-file, upload or managed-launch switches. |
| Native environment and kwargs | Abort for `forward_hf_token`, user env/token bindings, embedded credentials, unapproved commands or arbitrary extension fields. A false forwarding default is not proof against other exfiltration paths. Reject unknown execution capability, not just known-dangerous spellings. |
| Harbor Python to Sandbox | Only immutable reviewed built-in agent code may run in the credential-bearing controller. Installation command strings execute inside the Sandbox through native agent methods. User-authored Python imports are never admitted there. A reviewed catalog must account for constructors, model resolution, host file reads and indirect subprocesses too. |
| Provider observations to lifecycle actions | Missing, conflicting or ambiguous ownership stops admission and requests operator review. Never cancel all Jobs in a namespace, infer ownership from timing/image/flavor, or intercept private handles. |

Two native configuration examples used in offline round-trip tests are Pi
(`kwargs.version`, `kwargs.thinking`) and Codex (`kwargs.version`,
`kwargs.reasoning_effort`). They exercise different native option data through the
same code, with `environment.type: hf-sandbox` and native flavor/timeout kwargs.
They are **not** an approved executable catalog, route-compatibility claim, or
installation test. Future review data should describe immutable source identity,
controller-code trust, sandbox installation, required native API, allowed
nonsecret overrides and host-access capabilities, rather than inventing another
agent schema. Harbor CLI discovery/options remain the source of agent metadata.

## Process owner and staged flow

1. **Native configuration authoring (available):** save immutable named fragments;
   preserve native fields verbatim. No task resolution, inference, CLI child,
   capacity reservation or Run is created. Versioned saved configuration is not
   versioned execution approval.
2. **Nonexecuting validated plan (blocked):** policy review first; a disposable,
   credential-free isolated preparation Job must use a supported public Harbor
   CLI operation to resolve the exact tasks and emit its native lock. It must not
   execute agent/task hooks. No such integration is implemented. `--print-config`
   alone must never be labeled this stage.
3. **Review binding (future):** approval must bind the exact native config and
   lock, Harbor/source/image revisions, reviewed capabilities, principal, expiry,
   namespace and resource/cost limits. Any change invalidates review. Reuse
   existing wrapper-owned versioning where applicable; no new durable approval
   schema is introduced by this document.
4. **Execution (disabled):** only after public preparation, ownership and cost-stop
   contracts are proven and separately approved could the single TypeScript owner
   invoke a reviewed Harbor CLI child inside the Space. Harbor alone executes
   trials and controls concurrency/retry/resume. No Python controller fallback,
   second scheduling loop, private hook, or automatic restart implementation.
5. **Output/recovery (future):** read native `config.json`, `lock.json`,
   `result.json` and trial output as authoritative; never delete interrupted trial
   results, fabricate locks, or write below `job/`. TypeScript owns platform
   actions only with exact proven Job ownership. A duplicate controller, revision
   mismatch, unknown cost, cancellation failure, or immutable conflict is a stop,
   not a reason to relaunch or reconstruct Harbor state.

### Fixed process invocation contract (design only)

The reviewed executable is `harbor`, never a caller string or shell script.
The future execution argv is exactly `["harbor", "run", "--config", PATH]`,
where PATH is a control-generated regular file in the approved Run workspace,
not a URL, symlink escape, caller path, or repeatable override. No arbitrary
extra flags, `--plugin`, `--launch`, `--upload`, or `--env-file` are appended.
stdin is closed. Output is bounded, treated as untrusted text, and never used to
scrape HF Job identity. No process is invoked by the new tests.

A preview/discovery subprocess, if later implemented, must receive an explicit
nonsecret environment allowlist and isolated HOME/cache/workspace: no inherited
process environment, authentication files, mounted Bucket, persistent secret,
`PYTHONPATH`, `PYTHONSTARTUP`, preload or proxy injection variables. A reviewed
execution child is a separate trust boundary, not a preview process with extra
flags; its credential environment still needs exact review. The missing
preparation command is deliberately not given an invented name or implemented
using imports of `harbor.job` or lock-building internals.

## Credential and resource map

| Location | Current permission | Future constraint, not authorization |
| --- | --- | --- |
| Browser / saved configuration / preview / Bucket artifacts | Neither persistent secret | No embedded values or grant tokens; approval contains nonsecret bindings only. |
| TypeScript owner in `<control-space>` | Existing control access stays here; no new reads in this phase | HF_TOKEN may authorize only reviewed platform operations inside the Space. |
| Candidate Harbor CLI child inside the Space | Not started | Only reviewed trusted code; no arbitrary plugins or host commands with secret access. HF_TOKEN never crosses out of the Space. |
| Isolated preparation Job | Not created; credential-free by contract | No auth mounts, inference or executable task hooks; exact native lock required. Private task delivery is not solved by this proposal. |
| Sandbox / worker | Neither persistent secret forwarded | HF_TOKEN forbidden. Existing operator inference-only credential delivery would need separate approval for exact source, destination and mechanism. |
| Local development | No credentials or inference | Offline schemas/mocks only. |

One private `<control-space>` and one private `<artifact-bucket>` remain the
steady-state inventory. No new service, persistent store or resource is proposed.
A user logging in does not imply user-funded Jobs or inference. Future server-only
OAuth Jobs and inference scopes, retaining access tokens, consent, billing and
credential storage require separate approval; current sessions are not a token
vault. Do not implement grants or delivery now.

## Precise blocked public contracts

- **Isolated native preparation:** Harbor needs a supported credential-free CLI
  preparation boundary that resolves exact tasks and writes its own reusable lock
  without launching trials, importing untrusted agent/task code, or using managed
  remote launch. The smallest proposed public change is that CLI operation with
  a documented lock-consumption contract. It eliminates any local resolver/lock
  builder. Until an exact revision provides it, no preparation implementation.
- **Ownership and recoverability:** public Sandbox creation needs caller ownership
  metadata and Harbor must propagate it and expose durable provider identity via
  its public output boundary. Metadata alone is insufficient without recovery
  binding. Do not derive HF Job IDs from native trial IDs or list-and-cancel all
  Sandboxes. No private SDK patch or handle interception is authorized.
- **Hard lifecycle/cost stop:** idle shutdown and the SDK's 24-hour maximum do not
  implement an approved per-Run hard ceiling. Safe cost stops require public
  authoritative cost and exact owned-Job cancellation, including failed attempts;
  no shadow cost/result ledger or plugin inspecting Harbor internals is proposed.

These are local proposed changes, not reopened issues or upstream comments.
No temporary adapter is implemented: no removal revision can yet be named. Further
local guard tests need no execution approval; implementing these missing general
capabilities or publishing proposals requires separately scoped authorization.

## Acceptance evidence and limits

`apps/control-api/test/api.test.ts` now exercises eight hostile input shapes in
both write modes: custom agent import, import selector in name, controller plugin,
CLI args, forwarding, env binding, verifier hook and host paths. Each must receive
`503 execution_disabled` before the submission handler, storage mutation, Job
start/cancel, reconciler start, credential getter or network call. A query named
`preview` cannot bypass this boundary. Two native harness configurations round-trip
unchanged and still cannot launch. Existing tests cover all Run/setup action URLs.

`packages/control-core/test/control.test.ts` also uses throwing input/dependency
proxies: direct submission, cancellation and reconciliation must reject without
inspecting them. These are actual control-boundary tests, not simulated Job runs.
No new persisted field, API value, UI control, schema or runtime policy was added.
Tests do not prove safe arbitrary configuration, a complete catalog, isolated lock
preparation, real installation, credential delivery, ownership or executable E2E.

Validation for this phase: 417 unit tests (19 added), eight mocked browser tests,
32 agent-package tests, format/lint/type/build/generated checks, npm audit and
both Linux/AMD64 image builds passed. DRY and non-baseline structure checks passed.
The repository coverage gate remains red (72.83% lines, 70.22% statements,
68.59% functions, 63.14% branches; required 85%), and the structure baseline is
missing. No threshold or runtime policy changed. No root Python source changed;
its full suite was not rerun. No remote operations or inference occurred.
