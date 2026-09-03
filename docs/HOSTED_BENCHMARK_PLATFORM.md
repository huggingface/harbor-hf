# Hosted benchmark platform

## TL;DR

Harbor-HF lets an authorized user select immutable benchmark, model, harness,
deployment, and launch-policy profiles; review cost and execution policy;
launch a hosted Harbor Run; follow logical and physical progress; and obtain a
verified result with portable evidence.

## Purpose

The platform makes serious benchmark execution available without requiring an
operator workstation to run tasks, host models, or remain online. It preserves
enough evidence to distinguish model behavior from infrastructure failure and
to explain how every published score was produced.

## Product experience

An authorized user can:

1. browse promoted compatible profiles;
2. inspect the resolved model, harness, API, hardware, attempt policy, and
   maximum cost;
3. submit one immutable Run;
4. observe preparation, execution, retries, cancellation, and cleanup;
5. inspect private task evidence and normalized results; and
6. publish approved result views from the same canonical evidence.

The CLI and web console use the same API and durable control path.

## Platform boundaries

### Control

One protected control Space accepts requests, composes profiles, records
immutable intent, reconciles remote actions, and publishes results. One private
Bucket is durable truth. SQLite and browser sessions are disposable views.

### Execution

Harbor prepares each exact job and runs each prepared trial in HF Jobs. Harbor
owns task resolution, agent loading, task execution, verification, and native
results.

For inference-backed execution, the selected Harbor agent receives the
profile-resolved upstream and Job credential through `AgentConfig.env` and
calls the Hugging Face inference service directly. Chat Completions and
Responses remain distinct compatibility choices. Managed Endpoints are a
separate deployment route with explicit ownership and cleanup.

### Evidence

Every logical task retains its prepared lock, physical attempts, selected
outcome, Harbor result, workspace evidence, required session or trajectory,
verifier evidence, provenance, checksums, and infrastructure receipts.

Evidence is content-addressed and validated before selection. The exact
requirements are profile-driven.

### Publication

Publication derives normalized rows, result tables, ATIF traces, Harbor Hub
submissions, and approved public comparisons from one canonical private result.
Workers do not publish directly.

## Comparable and trustworthy results

Changed benchmark inputs, model route, agent version, inference API, runtime
limits, worker image, or attempt policy produce a different result identity.
Aliases never replace exact locked profile IDs.

Infrastructure and semantic outcomes remain separate. A transient,
replacement-eligible infrastructure failure may receive a bounded physical
replacement. A model refusal, benchmark timeout, agent outcome, verifier
outcome, or valid zero remains part of the semantic result.

Unknown hosted-service internals are reported as unknown. A direct-inference
Run does not claim an unobserved model commit, hardware type, quantization, or
serving engine.

Published comparisons use the same task denominator, task selection, attempt
rules, and score calculation. Partial, diagnostic, corrected, and composite
results are labeled and do not silently enter an ordinary comparable cohort.

## Harness and benchmark support

Harnesses are immutable profiles with exact package or Git revisions, Harbor
entry points, supported APIs, reasoning controls, environment requirements,
session policy, and trace format.

A new supported benchmark or model should need profile data only. A new
harness should need a Harbor agent plugin and profile only. Shared control and
worker code does not branch on product names.

ATIF is the portable trajectory format. A harness that writes valid ATIF keeps
its output. A shared converter may handle a reviewed native session format.
Benchmark-specific converters do not belong in the control core.

## Secret handling and security

`HF_TOKEN` stays in the control Space and never enters a Job.
`HF_INFERENCE_TOKEN` is sent only to an execution Job whose immutable
deployment requires direct inference. The reviewed Harbor agent is an intended
consumer of that credential.

Workers use a separate short-lived capability for evidence and attempt APIs.
They never receive a writable canonical Bucket mount. Browser responses and
public results omit credentials, capabilities, private topology, and raw
private evidence.

Direct inference means arbitrary user-authored agents cannot safely receive a
platform inference credential. Such recipes remain setup-only unless promoted
as reviewed immutable harnesses. General user-funded credentials remain
unsupported until short-lived custody, isolation, leak response, and spend
attribution are designed and verified.

Known secret values and high-confidence credential patterns are scanned in
paths and bytes across logs, sessions, traces, workspaces, manifests, results,
and publication candidates. A finding quarantines the attempt. Canonical
evidence is not rewritten to conceal a leak.

## Roadmap

### Reliable execution

Keep failure classification, cancellation, cleanup, cost reconciliation, and
bounded replacement behavior consistent across all benchmarks and harnesses.

### Broader catalog

Grow through reviewed profiles and Harbor agent packages while keeping one
generic control and worker path.

### Self-service Runs

Offer approved choices, transparent estimates, enforced ceilings, progress,
and cancellation. Add user-funded execution only after the secret-custody and
spend-attribution boundary is complete.

### Portable evidence

Use stable Harbor locks, native sessions, ATIF trajectories, provenance, and
normalized result records across Harbor-HF, Harbor Hub, and compatible tools.

### Public results

Provide stable links, filtering, task details, cost, runtime, outcome classes,
and trace inspection without exposing private evidence.

### Scale

Improve physical scheduling and storage without changing logical trial
identity, result semantics, or evidence requirements.

## Non-goals

Harbor-HF is not a general remote-compute service. It does not support
arbitrary unreviewed execution images, public raw evidence, benchmark-specific
workers, inferred hidden serving details, or a separate control system per
harness.

## End state

A developer can choose a supported evaluation, understand exactly what will
run and what it may cost, launch it, follow progress, and receive a verified
result. Another person can inspect the public record and understand inputs,
outcomes, failures, score calculation, and evidence provenance.

## Related documents

- [Control service](CONTROL_SERVICE.md)
- [Architecture](architecture.md)
- [Harbor compatibility contract](harbor-integration-contract.md)
- [Harbor agent architecture](provider-agent-architecture.md)
- [Result publication](result-publication.md)
