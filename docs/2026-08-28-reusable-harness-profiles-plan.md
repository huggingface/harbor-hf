---
title: Reuse harness profiles across models
author: Harbor-HF maintainers
date: 2026-08-28
tags: [profiles, agents, runs]
---

# Reuse harness profiles across models

> **Historical record — superseded 2026-09-02.** This plan preserves the
> profile migration reviewed at the time, including retired terminology and
> harness examples. It does not authorize new work on those paths. Current
> profile composition is defined by
> [`CONTROL_SERVICE.md`](CONTROL_SERVICE.md).

**Historical status.** The profile refactor was implemented under the recorded
scope. Its former review and completion instructions are superseded.

Harbor-HF currently selects separate model and harness profiles, but each
harness profile still contains a model route. Pi profiles also repeat model
metadata in a generated registry. Deployment profiles contain another form of
the route for the root bridge. This requires a new harness profile for each
model and makes route values easy to copy incorrectly.

Before this change, the active catalog had 33 harness profiles for 13 distinct
agent configurations after model-only values were removed. The active catalog
now keeps one profile for each real agent configuration and builds the full run
configuration before Harbor-HF admits paid work.

The [control service specification](CONTROL_SERVICE.md#profile-ownership-and-run-composition)
defines the durable contract. The [provider agent architecture](provider-agent-architecture.md#run-native-execution-contract)
defines the agent boundary. The [Harbor compatibility contract](harbor-integration-contract.md#execution-input)
defines how preparation uses the locked configuration.

## Ownership

A model profile owns the model ID and exact revision. It also owns the canonical
Harbor model route and typed model-family compatibility facts. The route is
written by hand in one place.

A harness profile owns the agent implementation, agent version, reasoning mode,
and evidence requirements. It also owns supported APIs and capabilities plus
stable agent settings.
It does not contain `model_name`, provider suffixes, prices, context limits,
output limits, or Pi `models_json`.

A deployment profile owns provider and execution policy. This includes the API,
prices, context and output limits, hardware, and worker image and revision. It
also owns the Harbor version and concurrency limits plus all timeouts. Its active
form does not contain
`trial_job_template.inference_model`.

Real harness variants remain separate when their behavior differs. Examples
include `pi-off`, `pi-high`, `dsh-off`, and `dsh-high`. An exact model route is
not a harness difference.

## Locked run configuration

Every new run lock contains a versioned resolved execution contract before any
reservation or action is written. The contract records:

- source profile IDs for the selected model and harness plus the deployment;
- the complete Harbor `AgentConfig`;
- the full agent model route and derived bridge route;
- provider and API details;
- upstream settings, prices, and request limits;
- context and output limits;
- concurrency limits and timeouts;
- the worker image and revision plus the Harbor version.

The normal run-lock digest protects the resolved contract. Preparation and trial
workers use the locked values. They do not read newer catalog profiles or rebuild
the relationship between the selected profiles.

The resolver derives the bridge route from the canonical Harbor model route. It
first verifies the Harbor provider segment and provider suffix, then removes
only the first Harbor provider segment. No deployment profile stores a second
route string.

## Compatibility checks

The resolver checks the complete combination before run admission. It verifies:

- the deployment allows the selected model and harness;
- the harness supports the deployment API;
- model-family requirements match harness capabilities;
- the Harbor route has the required structure;
- the route suffix matches the deployment provider;
- protected deployment values are complete and valid.

A failed check writes no run, reservation, or action. A repeated request with
the same idempotency key adopts the same immutable lock. A conflicting request
fails without changing durable state.

The resolver uses fixed typed rules. It does not support profile inheritance,
path expressions, placeholders, generated matrix source tables, arbitrary
bindings, or untyped model overrides.

## Agent runtime data

The complete locked `AgentConfig` contains the selected model name. Agents that
need no other model data use that value directly.

Pi receives a typed `model_runtime` value from the resolved execution contract.
It contains the model route and provider, API settings, context and output
limits, and prices. It also contains the safe base URL environment reference.
Pi validates this value and creates
`models.json` deterministically at runtime. The checked-in Pi harness profile
contains no model registry.

Model-family behavior has a typed owner. For example, a model profile can
declare its reasoning format, and a DSH harness can declare which formats it
supports. Harbor-HF rejects an incompatible pair before admission.

## Implementation

### Contract schema

Update `packages/contracts/schemas/control-record-v1.schema.json` and regenerate
the contract outputs.

The active harness shape becomes a model-independent agent template with typed
capabilities. The active deployment shape no longer accepts an inference model.
New run locks require a resolved execution contract.

Historical run locks use a separate legacy branch in the reader schema. That
branch exists for projection and audit only. It is not accepted for a new
profile object or new run.

### Execution composer

Add a focused TypeScript module under `packages/control-core/src/`. It loads the
selected profiles, performs the compatibility checks, builds the exact Harbor
agent configuration, derives the bridge route, and returns a byte-stable
resolved execution contract.

The composer runs during submission before budget reservation or action
creation. The service writes its result into the run lock. Existing idempotency
rules apply to the complete lock.

### Launch and preparation

Change prepared trial launch construction and reconciliation to use the locked
execution contract for route, API, limits, worker provenance, and bridge
settings.

Change `control_prepare_worker.py` to consume the exact locked Harbor agent. It
must not add a model route or compare copied route values for new runs. Prepared
job and trial submissions must match the execution contract.

### Agent support

Change Pi to validate the locked `model_runtime` value and create its private
model registry. Preserve its current cleanup and safe environment handling.

Add typed reasoning-format handling for DSH only where the selected model and
harness require it. Other agents continue to use the locked `model_name` and
their stable harness settings.

### Catalog conversion

Replace model-bound harness copies with one active profile per real agent
configuration. Use harness names that describe behavior, not a model. Use
provider-qualified model names when the provider is part of the route.

Update deployment allowlists and UI choices. Update CLI catalog output and
examples, then update the tests. Regenerate every changed content-derived
profile record ID. Remove
model-only harness files from the active catalog.

Before removing or renaming a public alias, inspect repository references,
documentation, API use, and known external use. When evidence requires
compatibility, keep an alias for one documented release. The alias must resolve
to the new composition path and must state its removal release.

The established `pi` and `dsh` names remain as harness aliases for the first
release with this cutover. They resolve to `pi-off` and `dsh-off`. The existing
`gpt-oss-20b` model name also remains as an alias for
`gpt-oss-20b-together`. The following minor release removes these aliases. The
recently added model-bound harness names have no independent configuration and
leave the active catalog without aliases.

## Historical records and cutover

No historical request, lock, task, attempt, prepared job, evidence object,
publication, or cost record is rewritten or deleted.

Before the new code is deployed, every old-format run must be finished. Its
Jobs and Endpoints must be terminal. Its action queue and cleanup state must be
clear, and publication must require no further write. An old-format run blocks
the cutover while any of those facts remain.

After the cutover, old locks can be read and exported for audits. They
cannot create, resume, or retry work. New code writes only the new lock form.
There is no dual write.

Rollback to old-only code is allowed before the first new-format lock is stored.
After that point, a rollback revision must read both lock forms and must continue
to write only the new form. Historical records remain unchanged in either case.

## Verification

The implementation must prove all of these results:

- schema generation is current;
- active harness fixtures reject model data;
- active deployment fixtures reject copied model routes;
- one FX profile composes with at least two models;
- one Pi profile composes with at least two models;
- composition produces stable bytes;
- malformed routes and incompatible combinations fail before any write;
- repeated submissions return the same complete lock;
- prepared Jobs and trial launches use only locked values;
- Pi creates current-equivalent model registries and removes runtime files;
- DSH rejects an unsupported reasoning format;
- historical locks remain readable and cannot launch work;
- an active old-format run blocks the cutover;
- protected model and provider values do not change;
- protected price and context values do not change;
- protected worker values do not change;
- benchmark and evidence values do not change;
- publication and budget values do not change;
- the active harness catalog falls from 33 files toward the 13 real
  configurations.

Run the repository format, lint, type, generated-file, build, and privacy
checks. Also run the required JavaScript and Python tests, browser tests,
dependency and Docker checks, plus Slophammer. Use the commands required
by `CONTRIBUTING.md`. Run pi-reviewer against `main` until no P0 or P1 finding
remains. Inspect pull request comments and verify CI at the exact pushed head.

## Failure handling

Stop the change when a migrated protected value differs from its current value,
a historical lock cannot be read, an old run still needs a mutation, or a new
run can reach admission without a complete execution contract.

Do not solve a failure with a profile fallback, a second writer, a generated
matrix, or a route copy. Correct the single owner or the composer, then rerun the
focused and complete checks.

## Boundaries

This change does not modify Harbor upstream, Pi core, an external agent CLI,
provider behavior, Hugging Face platform behavior, credentials, or remote
resources. It does not change model revisions, providers, prices, context
limits, worker pins, Harbor version, benchmark tasks, evidence rules,
publication meaning, or budgets.

The implementation may create a branch and commits. It may also open a pull
request. It does not merge or release. It does not deploy, run a benchmark, or
start paid compute.
