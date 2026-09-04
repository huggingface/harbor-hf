---
date: 2026-09-04
author: Harbor-HF maintainers
title: Harbor-HF Design Principles
tags: [architecture, harbor, design]
---

> **Execution-disabled integration (2026-09-04):** This greenfield branch is not
> production-ready. Run submission, actions, remote setup tests, and automatic
> reconciliation are disabled before admission or credential resolution, even
> when configuration writes are enabled. Workbench saves native Harbor JobConfig
> fragments; New Run previews configuration without task resolution or a Job.
> HF_TOKEN stays exclusively in the control Space. Neither persistent secret is
> forwarded. Parent-worker execution and private Hub/Harbor patches are removed.
> Execution descriptions below are deferred design, not available behavior or
> permission to launch. See [execution boundary](../docs/execution-disabled-integration.md).

# Harbor-HF design principles

Harbor-HF adds hosted Hugging Face control around Harbor. It MUST NOT replace,
copy, or reinterpret behavior that Harbor already provides.

This rule applies before code is written. A feature request MUST NOT count as
evidence that Harbor lacks the feature. A contributor MUST inspect the pinned
Harbor source first and MUST use its public configuration and APIs when they
exist. The pull request MUST record the files that were checked.

## Requirement terms

`MUST` and `MUST NOT` mark requirements. `SHOULD` and `SHOULD NOT` mark the
expected design unless the pull request gives a concrete reason for an
exception. `MAY` marks an allowed choice.

## Reason for the rule

Duplicate behavior creates two systems with the same responsibility. Each system
can make a different decision about task selection, retries, resume, locks,
results, costs, or agent execution. A run can then appear complete in one system
and incomplete in the other.

Copying Harbor also makes Harbor-HF harder to change. Every upstream fix requires
a matching local fix. New local fields need schemas, storage, API routes, UI
controls, migration rules, and tests. The copy can look useful at first while it
quietly becomes a second run engine.

Harbor remains the run engine and the source for run semantics. Harbor-HF stays
small when it stores only its own decisions and reads Harbor's normal output.
This gives each fact one owner and makes failures easier to diagnose.

## The first design question

A contributor MUST ask this before adding a field, record, loop, worker, parser,
adapter, or UI control:

> Does Harbor already represent or perform this?

The contributor MUST inspect the pinned Harbor revision and relevant history
when the current shape is unclear. The pull request description MUST name the
checked Harbor files and public APIs.

If Harbor already provides the behavior, Harbor-HF MUST use it directly.
Harbor-HF MUST NOT add a local alias, mirrored field, fallback reader, second
state machine, or wrapper that renames the same concept.

## Harbor responsibilities

Harbor owns the benchmark run itself. Harbor-HF MUST use Harbor for:

- `JobConfig` validation and job construction
- benchmark dataset and task resolution
- trial creation and attempt identity
- trial concurrency and execution order
- retry and backoff behavior
- resume and completed-trial discovery
- job and trial locks
- environment lifecycle inside a trial
- agent setup and execution
- verifier execution and rewards
- job and trial result files
- token and cost totals reported by agents, including timing
- trajectories and other normal trial artifacts
- built-in agent implementations

Harbor's job directory is the durable record for these facts. Harbor-HF can
project them for display, but it must not write a competing version.

## Harbor-HF responsibilities

Harbor-HF MUST limit its ownership to behavior outside a Harbor run:

- authenticated submission and operator access
- reviewed choices that restrict which Harbor configurations can be launched
- delivery of credentials without storing them in run configuration
- the control Space and canonical Bucket
- parent and child Hugging Face Job ownership labels
- starting and stopping Hugging Face Jobs
- a post-trial cost stop around Harbor's reported cost
- a disposable projection for queries and display
- the web console and public leaderboard

A reviewed preset should stay close to a Harbor `JobConfig` fragment. It can
restrict values for safety or policy. It should not invent another name for a
field that Harbor already has.

## Work that MUST NOT be added

Harbor-HF MUST NOT add any of the following:

- a second task resolver or benchmark registry parser
- a second trial loop or attempt scheduler
- local retry, continuation, or resume rules
- another lock, result, reward, cost, or trajectory format
- run records that mirror `JobConfig` fields
- profiles that combine values already composed by Harbor configuration
- local agent implementations when Harbor has the required agent
- state that claims authority over Harbor trial progress
- compatibility paths that keep a superseded local run engine alive
- user-facing names for Harbor concepts that require translation without adding
  a real product distinction

A projection MAY copy Harbor facts into SQLite for queries. The projection MUST
NOT claim authority. It MUST rebuild from the Bucket and current Hugging Face
Job observations.

## Repository ownership

| Requested behavior | Primary home | Harbor-HF action |
| --- | --- | --- |
| Task selection, trial execution, retry, resume, locks, or results | Harbor | Configure or call Harbor directly. |
| A general environment or agent capability | Harbor | Propose an upstream change after user approval. |
| Authentication, reviewed launch policy, or credential delivery | Harbor-HF | Implement in the control layer. |
| Hugging Face Job labels and lifecycle control | Harbor-HF | Keep a narrow platform adapter around Harbor. |
| Run lists, live Job state, or leaderboard display | Harbor-HF | Build a disposable projection from owned sources. |
| A missing bridge between a Harbor API and Hugging Face | Integration adapter | Keep it small. Test it and define when to remove it. |

Opening an issue or pull request in the Harbor repository requires explicit user
confirmation for that specific action. A general request to fix Harbor-HF does
not grant that confirmation.

## Native configuration

Harbor-HF MUST use Harbor's names and structures in persisted configuration. It
MUST translate a value only at an external platform boundary.

For example, Hugging Face calls a hardware tier a `flavor`. Harbor passes that
value through its HF Sandbox environment configuration. The run form can label
the control as **Hardware**, while the stored Harbor configuration keeps the
native environment shape:

```yaml
environment:
  type: hf-sandbox
  kwargs:
    flavor: cpu-upgrade
    job_timeout: 30m
```

Harbor-HF MAY replace `type: hf-sandbox` with its labeled environment adapter
when it compiles the final job. The compiler MUST preserve the native
environment arguments and MUST add only the `run_label` argument required by
the adapter. The adapter MUST limit its changes to Harbor-HF integration needs,
such as Job ownership and target namespace selection. It MAY also deliver the
approved inference credential at the execution boundary. It MUST delegate
environment lifecycle and flavor handling to Harbor. It MUST NOT create a
parallel field such as `environment_flavor`.

The same rule applies to attempts and concurrency. It applies to timeouts and
retries. It also applies to agent and model settings. Keep native task names and
artifact paths. Keep native result paths. Use each Harbor field when it already
expresses the required value.

## Missing Harbor behavior

A missing general capability MUST go upstream in Harbor. The contributor MUST
stop local design work and report:

1. The user need that cannot be met.
2. The pinned Harbor revision and files checked.
3. The smallest public Harbor API or configuration change that would meet it.
4. The Harbor-HF work that becomes unnecessary after that change.

The contributor MUST get user confirmation before opening an upstream issue or
pull request.

A temporary Harbor-HF implementation MUST have separate approval. It MUST have
a narrow interface and a test for the exact gap. It MUST link to the approved
upstream work and MUST define a removal condition tied to a Harbor revision. It
MUST NOT become a second owner of Harbor state or execution.

## Review evidence

Every Harbor-HF behavior change MUST answer these questions:

- Which repository owns the behavior?
- Which pinned Harbor files and public APIs were checked?
- Which native Harbor configuration or output is used?
- Does the change add a mirrored field, state machine, parser, or result format?
- Can the same result be achieved with less Harbor-HF code?
- If an adapter is necessary, what exact upstream gap requires it?
- What event or Harbor revision permits removal of temporary code?

A pull request MUST NOT be marked ready when these answers are missing.
Reviewers MUST request deletion or simplification when Harbor already provides
the behavior.

## Related documents

- [Architecture](architecture.md)
- [Harbor-centered cutover specification](2026-09-04-simplification-implementation-spec.md)
- [Control service](CONTROL_SERVICE.md)
- [Harbor integration contract](harbor-integration-contract.md)
