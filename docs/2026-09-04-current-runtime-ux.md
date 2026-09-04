> Historical pre-integration design; superseded by [execution-disabled integration](execution-disabled-integration.md). Do not use these instructions to launch or deploy.

# Current-runtime harness library and New Run

This local UX milestone retains the current execution architecture. It does not
activate writes, upgrade Harbor, migrate records, or authorize remote work.

## User flow

Workbench configures command-agent installation, commands, and settings. Save
uses the existing owner-scoped, content-digest-versioned recipe library; changing
a named recipe creates another immutable version. Testing is optional while
authoring, but a saved version is neither a setup pass nor execution approval.
Workbench no longer launches local or hosted benchmarks. Existing local runtime
APIs remain unchanged.

New Run selects an existing benchmark selection, a promoted built-in harness or
an exact owner-saved version, and an exact model string. Suggestions come from
approved model profiles referenced by the server's reviewed configuration catalog.
The user explicitly selects the reviewed configuration when choosing the route;
there is no automatic provider creation, route substitution, or arbitrary subset.
Unknown model strings remain editable but cannot launch. Size is workload guidance,
not a price guarantee.

Advanced shows the reviewed provider, deployment, policy, and configuration
revision. The mixed registry remains at `/profiles` with unchanged access control,
under Advanced navigation. Launch still requires role and write-mode permission,
a positive ceiling within the configuration maximum, and explicit fresh review.
Changing a selection, evidence, or loaded profile identity clears confirmation.

Built-ins use the existing normal five-profile submission. A built-in not listed
by the selected configuration's approved deployment is unavailable in this UI;
an administrator must supply a reviewed compatible configuration. The UI does not
claim that every promoted profile has a reviewed catalog route. Normal admission
continues to resolve and validate all five current profiles server-side.

Saved versions use the existing Workbench submission, including the reviewed
configuration revision, exact recipe bytes, and matching setup test ID. Preview
must match the saved digest; setup must match both recipe and compiler revision.
The server still enforces owner-scoped attestation, harness policy, reviewed
workers, compatibility, pricing, and admission. Compilation creates the existing
Run-scoped execution binding, not a new globally approved harness profile.
Expired or unavailable setup evidence requires testing that exact version again.

## Upstream review and compatibility decision

Pinned Harbor: `b37833221e27435a18d7acdd41d875cdc2831893`.
Reviewed upstream: `dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e`, 109 commits later.
The upstream review was completed before this independent UI implementation.

Relevant Harbor files checked at the pin and/or compared with upstream:

- `src/harbor/models/job/config.py` and `src/harbor/models/job/lock.py`:
  dataset selection, installation-only behavior, and immutable job inputs;
- `src/harbor/models/trial/config.py`: native agent configuration;
- `src/harbor/cli/agents.py` and `src/harbor/cli/config_sources.py`:
  upstream agent discovery/schema and configuration composition;
- the preceding review also inspected `job_plan.py`, `job.py`,
  `agents/{base,factory,model_connection}.py`, `cli/jobs.py`, and
  `environments/hf_sandbox.py` for preparation and execution boundaries.

Native JobConfig and JobLock source is unchanged across these revisions, but
agent preflight/options and capability declarations changed. Schema equality is
not worker compatibility. No blind pin upgrade is included: historical locks,
workers, saved bytes, and compiler bindings remain untouched. A separately
verified worker matrix is needed before proposing the upgrade.

Upstream discovery (`harbor agent list --json` and agent schema, `ac476798`),
configuration composition (`163323d3`), and sandbox bash fixes (`cd0f894e`) must
not be reproduced locally. This change adds no agent discovery catalog, agent
option validator, config composer, task resolver, or Harbor patch. Existing
approved profile data supplies built-in display choices.

The target cutover still needs supported preparation/sealed-lock CLI contracts,
sandbox label propagation and non-root isolation decisions, and separate parent
Job credential and paid-test authorization. These are not prerequisites for this
wrapper UI. Cost ceilings are Harbor-HF-owned safeguards, not an upstream bug.
No issue, PR, deployment, inference, resource, credential change, or push is part
of this milestone.

## Local verification

- 806 unit tests and 11 browser tests passed. Browser execution APIs are mocked;
  these tests do not establish remote worker compatibility or authorize paid work.
- Formatting, lint, TypeScript, build, generated-contract checks, dependency
  inspection, and low-level npm vulnerability audit passed (zero vulnerabilities).
- DRY reported zero candidates; the non-baseline structure check passed.
- Coverage remains below the unchanged 85% global gate: lines 72.39%, statements
  71%, branches 62.60%, and functions 77.07%. The required baseline invocation
  cannot run without the missing baseline file, and the required mutation
  invocation targets a retired, absent script. These limitations remain visible;
  this milestone does not repair or waive them.
- No Python implementation, portable contract, worker, or Harbor pin changed.
