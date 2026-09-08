---
title: Configurable launch plan
author: Harbor-HF maintainers
date: 2026-09-08
tags: [launch, agents, configuration, interface, planning]
---

# Configurable launch plan

## Goal and status

Provide one New Job page where an operator can choose task sources, add agents,
configure their options, select Hugging Face model routes and sandbox hardware,
validate the complete request, and launch a normal Harbor run. Support built-in
agents and custom Git repository agents. Use the existing console visual style,
with repeated source and agent cards and collapsible advanced settings.

Status: planned, not implemented. This document records the target and the work
needed to reach it. It does not authorize implementation, publication, deployment,
credential transfers, paid tests, or new resources. The current runtime contract
remains in [Architecture](architecture.md) and [Control service](CONTROL_SERVICE.md).
This is the canonical implementation plan for configurable launch.

Follow [Design principles](DESIGN_PRINCIPLES.md). Harbor owns configuration, task
resolution, agent execution, trials, retries, locks, results, and trajectories.
Harbor-HF owns authenticated admission, reviewed restrictions, credential delivery,
HF Job lifecycle, cost stops, the console, and leaderboard eligibility.

## Requirements

- Use native Harbor `JobConfig` fields for every execution choice.
- Support multiple sources and multiple agents within one Harbor job.
- Keep reviewed presets as editable starting configurations. A changed value
  must not require a new preset file when deployment policy permits it.
- Offer built-in agents and custom repository agents through one interface.
- Derive built-in agent option controls from the pinned Harbor schemas.
- Keep the form and native JSON editor synchronized around one configuration.
- Provide an explicit Validate action followed by Launch. Show field errors,
  resolved trial counts, effective configuration, and applicable cost limits.
- Show only supported HF controls. Explain disabled options and known limits.
- Keep the current responsive layout, keyboard access, loading states, error
  notices, run pages, trial pages, and pause, resume, and cancel controls.
- Use one submission contract for the browser and CLI. Keep one parent HF Job
  per active run and let Harbor expand sources, agents, and attempts into trials.

## Scope and non-goals

The first implementation serves authenticated, trusted operators. It supports
reviewed built-in agents and approved immutable public repository sources using
Harbor's native ACP implementation. Keep the existing permitted CPU sandbox tiers.

This work does not add public untrusted code execution, private repository
credentials, an inference gateway, a new secret store, arbitrary parent-process
imports, a task image builder, local inference, managed model endpoints, or GPU
sandbox access. These capabilities need separate scope and approval.

Do not add another agent manifest, source installer, benchmark resolver, task loop,
retry loop, result format, persistent draft service, or per-run resource. Keep one
private control Space, one private Bucket, and the disposable three-table SQLite
projection. Do not build against browser-internal actions or captured page data.

## Upstream evidence

The checked Harbor revision is
`dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`, as pinned in
`packages/harbor-hf-agents/pyproject.toml`. Recheck these APIs if the pin changes.
Generate the schema catalog from the worker's exact revision, not a moving branch.

| Checked Harbor source | Native interface or fact | Planned use |
| --- | --- | --- |
| `src/harbor/models/job/config.py` | `JobConfig`, `DatasetConfig`, arrays of agents and sources, native retry and concurrency | Own all execution configuration. |
| `src/harbor/models/trial/config.py` | `AgentConfig`, `TaskConfig`, environment and verifier configuration | Use native option locations and types. |
| `src/harbor/job_plan.py` | `JobPlan.from_config`, `resolve_task_configs`, `build_trial_configs` | Resolve sources and trial expansion without a second resolver. |
| `src/harbor/agents/factory.py` | `AgentFactory.registered_names`, `get_agent_class_from_config`, `run_preflight` | Discover reviewed implementations and run native checks. |
| `src/harbor/agents/base.py` and `options.py` | `options_schema`, `parse_options`, declared option models | Generate and validate agent-specific controls. |
| `src/harbor/cli/agents.py` | `harbor agents list --json`, `harbor agents schema <agent> --json` | Export catalog evidence from the pinned installation. |
| `src/harbor/agents/model_connection.py` | Native endpoint and credential resolution declarations | Use native connection requirements instead of a copied provider map. |
| `src/harbor/models/agent/acp_source.py` | `AcpAgentSource`, `AcpSourceManifest`, `AcpPythonUvRuntime` | Use the native repository and manifest contract. |
| `src/harbor/agents/installed/acp.py` | `AcpOptions.source`, source verification, sandbox installation, ACP execution, source provenance | Delegate custom-agent execution to Harbor. |
| `src/harbor/agents/installed/pi.py` | `PiOptions`, inherited `version`, Pi package installation, native execution and usage output | Distinguish a Pi CLI release from a different harness implementation. |
| `src/harbor/environments/hf_sandbox.py` and `capabilities.py` | `HFSandboxEnvironment`, flavor and idle timeout, declared capability limits | Expose only supported HF settings. |

Relevant history includes custom repository agents in `488af1b1`, structured agent
capabilities in `f633b8a8`, declared agent options in `ac476798`, and the HF Sandbox
provider in `cc4b7be7`. The repository-source execution path is already native; no
new local source runtime is required for that supported case.

The source manifest at this pin supports ACP with Python 3.12 and uv. It does not
represent arbitrary Node or shell programs. HF Sandbox requires prebuilt task
images and does not advertise network-allowlist enforcement. These are real
capability limits, not missing UI fields.

## Launch page

Use an authenticated `/runs/new` page, reachable through the console's New Job
button. Keep `/overview` focused on status and recent activity. Replace its
embedded submission form when the unified page is ready.

### Sources

Render one card per source with Add source and Remove controls. Offer:

- Registry dataset: `datasets[].name` and optional `ref`, task filters, and task
  limit.
- Registry task: `tasks[].name` and optional `ref`.
- Git repository dataset: `datasets[].repo` and its native repository-relative
  qualifiers, filters, and task limit.
- Git task: `tasks[].git_url`, `git_ref`, and repository-relative `path`.

Use Harbor's public source and registry APIs for resolution. Search suggestions
are bounded, cancellable reads; they do not become a local registry. Do not allow
server-local paths, arbitrary download destinations, or alternate credential
transports. Public-source admission must constrain hosts, schemes, redirects,
and resource use before a fetch.

A source card is not a task count. Show counts from Harbor's resolved plan. Until
resolution finishes, display the count as unavailable rather than using the
number of cards as the number of tasks.

### Agents

Render one card per native `agents[]` entry. Each card contains:

- Built-in agent or custom Git repository selection.
- Model and HF inference provider selection for that agent.
- Agent options, including version and reasoning only when declared.
- Supported nonsecret environment values and timeout settings.
- Validation status and an explanation of route or runtime restrictions.

Generate built-in controls from the reviewed implementation's `options_schema()`.
Preserve unset, explicit null, false, zero, and empty values where the native
schema distinguishes them. Showing a default must not silently insert that value.
For unknown or unsupported schema shapes, retain a validated native JSON editing
path rather than inventing a different field definition.

The catalog is generated from pinned installed code and served by the control
API. Deployment policy can restrict its entries and values. Policy must not
redeclare Harbor's field types, defaults, or agent capabilities. Only reviewed
installed classes may be imported during discovery or preflight.

### Custom repository agents

Use the following native agent fragment. It is an example of field placement,
not a launch-ready request or approval of a repository:

```json
{
  "name": "acp",
  "kwargs": {
    "source": {
      "repo_url": "https://github.com/<owner>/<agent-repository>",
      "ref": "<full-commit-sha>",
      "source_dir": ".",
      "manifest_path": "harbor-agent.json"
    }
  }
}
```

The form edits `agents[].kwargs.source` directly. Require an approved full commit
SHA for execution. Do not accept a moving branch as an immutable launch identity.
Use the native manifest digest field when approval binds the manifest bytes.

Harbor verifies the source, installs it inside the task sandbox, executes ACP,
and writes provenance and trajectories. Do not call its private source-fetch or
installation helpers from the control service. Validation of the source shape
must not be described as a successful installation test.

Never import user repository code into the Space or parent process. A submitted
`import_path`, including an import-path shorthand in `name`, must not bypass the
reviewed agent allowlist. Source and option validation must occur before agent,
environment, or metric factories can load user-selected Python code.

### Worked example: a specific Pi version

A released Pi version is an option of the Pi agent, not a new agent type or a
custom repository source. The following walkthrough describes the planned UI;
it does not claim that the current preset form already has these controls.

1. Open New Job and select a benchmark source or load a reviewed preset.
2. Select Add agent, choose the built-in/installed agent path, and select Pi from
   the reviewed catalog. Show the actual Harbor implementation in the card's
   configuration details.
3. Expand Agent options and set Version to `0.84.4`, or another exact approved
   release. This edits `agents[].kwargs.version`. Set Thinking to `high` if
   supported; this edits `agents[].kwargs.thinking`.
4. Enter the HF model ID and select a live, compatible inference provider. These
   choices belong to this agent card, independently of its Pi version.
5. Set attempts, concurrency, the cost limit, and diagnostic role. Select Validate.
6. Review the resolved tasks, Pi implementation, requested version, thinking,
   model route, sandbox hardware, and remaining runtime checks. Select Launch.
7. Open the run and inspect its trial results, Pi output, trajectory, and observed
   agent version. A successful launch request alone does not prove which version
   executed. An observed version mismatch must fail the reproducibility check.

For the currently reviewed Pi integration, the native agent fragment is:

```json
{
  "import_path": "harbor_hf_agents.pi.agent:PiAgent",
  "model_name": "huggingface/<publisher>/<model>:<provider>",
  "kwargs": {
    "version": "0.84.4",
    "thinking": "high"
  }
}
```

This fragment omits the service-injected credential template. It is not a complete
submission. The import path is selected from the reviewed catalog; it is not a
free-text Python import field. This integration currently adds provider-pinned
pricing and ATIF output around Harbor's native Pi agent. Keep those required
behaviors when considering a later native implementation replacement.

The checked Harbor Pi installer uses the version to install the corresponding
published Pi CLI package inside each task sandbox. It does not use the Pi
installation, packages, credentials, or personal instructions on the operator's
computer. A version-only change does not require another parent image when the
existing reviewed integration supports that release. Reject unsupported releases
instead of silently choosing a different one. Hosted reproducible runs must use
an exact approved version even though native Harbor can default to latest.

The planned card should make these separate choices visible:

| UI value | Meaning | Native location or source |
| --- | --- | --- |
| Agent: Pi | Reviewed Harbor implementation that runs Pi | `agents[].name` or the admitted `import_path` |
| Version: `0.84.4` | Pi CLI release installed in the task sandbox | `agents[].kwargs.version` |
| Thinking: `high` | Pi thinking option | `agents[].kwargs.thinking` |
| Model and provider | LLM route used by this Pi instance | Native `model_name` and approved runtime environment |
| Execution details | Harbor revision and reviewed parent image | Existing run and deployment evidence, not editable Pi options |

The schema of the selected Harbor implementation governs the fields. A feature
available in a newer local Pi installation does not automatically become an
option of the pinned Harbor integration.

### Worked example: a special Pi harness

Distinguish a Pi release from a harness that changes tools, packages, prompts, or
execution behavior. A Git branch, a package URL, or a name such as Pi with custom
tools must not be placed in the Version field and treated as a supported release.

If an existing reviewed installed Harbor agent already provides the harness:

1. Select that implementation from the same agent catalog. Its display label can
   explain the behavior, while details expose its real native name or import path.
2. Set its declared options, including a Pi version if that implementation exposes
   one. Do not create a separate persisted `variant` or `harness_profile` field.
3. Select the model route, validate, and launch through the same run endpoint.
4. Show the selected implementation and available native version/source evidence
   in the review and results. Do not report the harness as plain Pi if that would
   hide a material difference in the program that ran.

Adding a new installed implementation requires a reviewed code change, option
schema, tests, and a new pinned parent image before it appears in the catalog.
The UI cannot install an arbitrary Python plugin into the parent. Adding another
approved version of an already supported Pi CLI is a different, smaller action.

Pi has public package and extension mechanisms, but the checked Harbor Pi option
schema does not expose an arbitrary extension-package selector. Do not add a
fictional `extensions` kwarg, assume a generic `config` field loads packages, or
invent a shell-command escape hatch. A behavioral extension should use Pi's public
interfaces without changing its internals; supporting its setup through Harbor
requires evidence from the selected integration. If that support is absent,
report the exact upstream gap and seek approval before designing a new adapter.
This plan does not select extension hooks or change Pi session formats.

If the supplied harness is already packaged as a supported ACP repository agent,
choose Custom Git repository instead. Enter its repository URL, approved commit,
source directory, and native manifest path. The UI validates the native source
fields and exposes ACP options. It must not reuse Pi-specific Thinking or Version
controls unless the selected native interface actually declares them. Model
selection still needs compatibility evidence for that ACP implementation.

A plain Pi source repository or a Pi extension package is not automatically an ACP
agent. The checked custom-source runtime is Python/uv; do not imply that choosing a
Node repository will build or run it. A required unsupported harness remains
blocked pending an approved upstream capability, not silently routed through the
old command-agent recipe system.

### Worked example: comparing two approved Pi configurations

Select Add agent twice. Choose the same reviewed Pi implementation on both cards,
set two exact approved versions or different declared thinking values, and select
the intended model/provider on each. The resulting native `agents[]` has two
entries. Harbor runs both against the selected tasks and attempts within the
configured concurrency. It does not require two profile records or a new campaign
scheduler. A comparison is valid only if the intended controlled settings and
observed version identities are preserved in the results.

### HF routes, hardware, and credentials

Keep the model and provider controls in each agent card so multiple agents can
use different routes. Use live HF provider mappings and Harbor's native model
connection interfaces. Agent-specific protocol behavior belongs in the native
agent or a reviewed integration plugin, not branching logic in the launch form.

Do not treat a live model mapping as proof that an agent supports its API. Route
admission must account for the agent's actual protocol, required credentials,
and reviewed integration evidence. Explain unavailable combinations. Do not
silently change providers, protocols, models, or agent options to make a request
pass. An inference probe is a separately approved paid action, not validation.

Hardware edits `environment.kwargs.flavor`, restricted to the deployment's
permitted CPU tiers. Keep task resource requirements separate from the selected
hardware tier. Validate compatibility instead of assuming a memory override can
resize an HF tier.

HF Sandbox at the checked pin requires a prebuilt task image. Do not offer force
rebuild as an available operation on this backend. Do not offer network controls
as enforced when the backend lacks that capability. Label native `job_timeout`
as sandbox idle timeout; keep wall-clock agent, trial, and parent limits separate.
Keep control-owned job paths, ownership labels, and credential-forwarding switches
out of editable configuration. Do not add a display-name alias for a managed
native `job_name`.

Retain the existing separate control and inference credentials. The parent uses
the control credential only for owned infrastructure operations. Custom agent
code receives neither that credential nor a Bucket mount. Approved inference
credentials are injected only at the existing execution boundary. Requests and
drafts contain no secret values or arbitrary environment expansion templates.

An agent that receives an inference token can read it. This release therefore
requires trusted operators and approved source revisions; sandbox isolation is
not a credential proxy. Private source authentication and untrusted-agent token
isolation remain outside this plan.

### Execution and advanced settings

Expose native attempts, trial concurrency, per-agent concurrency where supported,
retry settings, and timeouts. Explain that attempts add scored trials, concurrency
changes simultaneous work, and retries are Harbor-managed failure recovery.

Place supported environment and verifier options, inline instructions, and native
JSON configuration in collapsible sections. The JSON editor edits the same object
as the form, not an additional deep-merged override document. Apply the same server
restrictions to both interfaces. Reject forbidden fields with their native field
paths; do not silently strip them.

The page may save a secret-free draft locally. Do not place drafts in query
parameters, logs, or public links. Draft restoration must not restore approval,
a successful validation claim, or launch confirmation. Show errors beside the
relevant field and in a summary that receives keyboard focus. Use explicit button
labels and preserve standard browser text-editing behavior.

## API and validation

Converge on `POST /api/v1/runs` with one native Harbor configuration and only
Harbor-HF-owned admission metadata. Reuse `harbor_job_config`, `role`, and the
existing cost-limit vocabulary where applicable. The implementation must finalize
the minimal request schema before generating clients; this plan does not introduce
a second configuration format.

Remove the separate preset submission shape, `/api/v1/runs/config` path, and
Workbench-specific launch payload at the replacement boundary. Presets populate
native configuration; they do not invoke a separate execution compiler. Keep
schema version `v1` and regenerate TypeScript, OpenAPI, browser, and CLI contracts
together. Do not retain aliases or fallback readers.

Add a read-only validation operation using the same admission functions as launch.
Keep browser session and CSRF protection, CLI bearer authentication, write-mode
checks, and idempotency. A validation response is not permission to bypass launch
checks or spend limits.

Validation order:

1. Validate the native shape and reject unsafe inputs before resolving sources or
   importing classes. Bound input size, source hosts, fetch duration, and output.
2. Validate options with the pinned reviewed agent implementation and evaluate
   HF restrictions. Keep native validation in a bounded invocation of the pinned
   Python package rather than rebuilding its semantics in TypeScript.
3. Use public `JobPlan` APIs for supported source resolution, task caching, and
   trial expansion. Restrict executable extension points before planning, since
   native planning can load metric implementations and resolve external inputs.
4. Report actual resolved task and trial counts, effective configuration,
   supported image and hardware checks, credential availability, and field errors.
   Separate checks actually performed from runtime checks that remain pending.
5. Bind the displayed review to the exact configuration and relevant revision or
   policy inputs. Changes invalidate it. Require immutable execution references;
   if resolution changes what the operator reviewed, request a new confirmation.
6. At launch, repeat admission checks, enforce idempotency, and store one immutable
   run before normal reconciliation starts the parent Job.

Validation creates no HF Job, performs no inference, executes no repository code,
and creates no durable run or preparation service. Native planning can download
data into bounded temporary storage. Any setup execution must be a separate,
explicit action with its own resource approval. If the required read-only check
has no safe public Harbor API, report the gap rather than copying a private helper.

## Records, costs, and results

The current run record's singular `submission.benchmark`, `submission.model`, and
`submission.harness` fields cannot represent a multi-source, multi-agent job.
Replace those mirrors rather than filling them with the first array entry.

Store native configuration once alongside Harbor-HF-owned identity, actor,
revision, role, and cost policy. Derive agent, model, version, and task identity
from native configuration and Harbor trial results. Keep source provenance in
Harbor's native artifacts. Update list summaries, filters, trial views, and the
leaderboard before admitting multi-agent runs.

The projection remains disposable and rebuilds from Bucket records and HF Job
observations. Harbor alone writes below `job/`. Do not add trial progress records,
separate source snapshots, or a second result authority.

Customized runs default to diagnostic. A final role does not itself establish
leaderboard eligibility. Eligibility must check the effective benchmark protocol,
including selected tasks, attempts, verifier settings, and extra instructions,
against the reviewed protocol. Editing a preset must not preserve eligibility by
name alone. Mixed-agent results must be grouped using their actual trial identity.

Show the distinction between observed inference cost, unknown cost exposure,
HF infrastructure cost, configured limits, and estimates. Keep missing costs
unknown. The existing post-trial cost stop is not a strict per-request spending
cap. Concurrency and retries can create exposure before the next result arrives.
Do not promise an exact cost or ETA without source evidence. New budget accounting
or a hard inference spending gateway requires separate approved scope.

## Implementation sequence

### 1. Native contract and admission

- Recheck the evidence table against the installed pin and deployment image.
- Finalize one minimal native-config request and the run-record changes.
- Replace single-agent assumptions in `packages/contracts`,
  `packages/control-core/src/service.ts`, `presets.ts`, `projection.ts`, and
  `leaderboard.ts`.
- Add strict admission before all import and source boundaries. Preserve permitted
  native environment kwargs instead of replacing them with unrelated defaults.
- Implement shared validation and submission in `apps/control-api/src/app.ts` and
  update `src/harbor_hf/cli.py` plus generated contracts.

Exit: native multi-agent requests round-trip through API, storage, and rebuilt
projection without duplicate execution fields or incorrect result attribution.

### 2. Catalog and launch page

- Export reviewed agent schemas from the pinned package with revision checks.
- Build the source and agent cards, generated option controls, HF selectors,
  execution settings, native editor, review summary, and local draft handling.
- Replace the form in `apps/control-web/src/pages.tsx`; update navigation, API
  helpers, queries, and browser tests.
- Keep run inspection and lifecycle controls on the existing routes.

Exit: form, JSON, and CLI requests produce equivalent native configuration;
unsupported settings and unsafe inputs receive explicit errors.

### 3. Native custom sources and existing Workbench

- Enable admitted immutable public ACP sources through native Harbor execution.
- Test the integration with harmless local fixtures and mocked HF boundaries.
- Inventory the required behavior in `apps/control-web/src/workbench.tsx`,
  `packages/control-core/src/workbench.ts`, and the command-agent plugin.
- Decide each unsupported existing use case explicitly: replace it with an
  equivalent native path, obtain approval to remove it, or obtain approval for an
  exact upstream extension. Do not quietly retain a second permanent launch path.
- Do not design a replacement runtime for unsupported source languages locally.

Exit: the required custom-agent behavior has an approved native path, and obsolete
Workbench recipe schemas, compilation, launch routes, and runtime code are removed
at the coordinated replacement. A setup pass is never treated as source approval
or proof of model compatibility.

### 4. Verification and release readiness

- Complete the acceptance checks below and update current operational docs.
- Inventory active and retained runs before changing the durable record shape.
  Do not strand active work, delete evidence, silently hide required results, or
  add legacy readers. Agree on the treatment of existing records before release.
- Replace the API, UI, CLI, and schemas together. Use a hard cutover with no v2
  contract or parallel execution path.
- After separate deployment approval, deploy first with writes disabled. Verify
  schema and worker revision agreement, readiness, privacy, and projection rebuild.
- Run remote setup, inference, or lifecycle canaries only with explicit scope and
  bounded paid-compute approval. Enable writes only after release requirements pass.

## Acceptance checks

- Multiple sources and agents resolve through Harbor into the expected actual
  trials. Changing concurrency does not change the scored attempt count.
- Preset selection fills native fields; edits use the same path as direct JSON.
- Agent controls match the pinned schemas, including enums and unset/null behavior.
- The Pi walkthrough preserves the admitted implementation, exact CLI version,
  thinking value, and model route in native configuration and result inspection.
  A version change uses the existing supported integration; an unsupported release
  or extension-package kwarg is rejected without fallback.
- Two Pi cards produce two native agent entries with separate result attribution.
  A special harness retains its real implementation identity; a plain Node or Pi
  package repository is not accepted as a supported ACP source merely by its name.
- Catalog, validator, and worker revision mismatches block launch.
- Form-to-JSON-to-form round-trips preserve all admitted native values.
- Validation has no compute or inference side effect. Its response labels checks
  that did not run, and changing the draft requires a fresh review.
- Duplicate submission returns the same run; reuse of a key for different input
  fails without creating another parent Job.
- Custom source input uses `agents[].kwargs.source`. Moving refs, unapproved
  revisions, unsafe URLs, local paths, parent imports, and credential-bearing
  literals fail before execution. Native provenance remains available on failure.
- Unsupported runtime manifests, task images, hardware, network controls, and
  model routes fail clearly rather than falling back.
- No user repository code executes during validation or catalog discovery.
  Custom code cannot receive infrastructure credentials or a Bucket mount.
- Browser drafts, validation errors, API responses, run records, and artifacts
  do not disclose credentials. Restored drafts confer no launch approval.
- Multi-agent projection rebuild, trial attribution, cost display, and leaderboard
  grouping match Harbor output. Customized benchmark conditions are not admitted
  merely because their original preset name was eligible.
- Harbor retry, result, pause/resume, and lock behavior remains authoritative.
- Desktop and mobile layouts, keyboard navigation, focus after validation errors,
  disabled-write states, loading states, and API errors have browser coverage.
- Removed contracts and runtime paths have no compatibility readers or aliases.

## Verification commands

For this documentation-only change, run focused checks only:

```bash
npx -y @simpledoc/simpledoc check
uv run python scripts/check_public_privacy.py .
git diff --check
```

For the later implementation, run the repository gates below. Add focused tests
for the acceptance cases before running the full gates. Remote tests remain
separate and require approval; these commands do not authorize them.

```bash
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest --cov=src/harbor_hf --cov-fail-under=85
uv run pip-audit
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run check:generated
npm audit --audit-level=low
npm run test:e2e
uv run --directory packages/harbor-hf-agents ruff check .
uv run --directory packages/harbor-hf-agents ruff format --check .
uv run --directory packages/harbor-hf-agents ty check
uv run --directory packages/harbor-hf-agents pytest
docker build --platform linux/amd64 -f deploy/control-space/Dockerfile .
docker build --platform linux/amd64 -f deploy/parent-worker/Dockerfile .
uv run slophammer-py check . --baseline
uv run slophammer-py dry .
uv run python scripts/check_public_privacy.py .
git diff --check
```

## Decisions required before implementation or release

- Confirm the allowed custom source repositories and immutable revisions. A valid
  manifest does not approve execution of its contents.
- Resolve required Workbench use cases outside the native Python/uv ACP contract.
  Upstream work requires explicit approval and an exact removal condition for any
  separately approved temporary implementation.
- Confirm treatment of active and retained records before the schema replacement.
- Confirm deployment and any paid canary scope separately. This plan grants none.
