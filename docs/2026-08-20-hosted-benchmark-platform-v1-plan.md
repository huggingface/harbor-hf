---
title: Hosted Benchmark Platform V1 Plan
author: Harbor-HF maintainers
date: 2026-08-20
tags: [harbor, hugging-face, benchmarks, harnesses]
---

# Hosted benchmark platform v1 plan

Harbor-HF already provides the control service, web application, immutable profiles, remote workers, evidence storage, and result publication needed for hosted benchmark runs. The next milestone is to prove this path with a real campaign, make infrastructure failures explicit, add Terminus 2 through the generic harness interface, and publish compatible results to Harbor Hub.

A dedicated Hugging Face organization already exists for the hosted application and public result resources. This plan does not create another organization, repository, Space, Bucket, or control service.

## V1 scope

V1 supports fixed, reviewed benchmarks and harnesses. An operator selects approved benchmark and model aliases. They also select a harness and deployment. The launch policy is selected separately. The control service resolves every alias to an immutable profile before it creates a campaign.

The launch screen shows the resolved configuration and logical task count. It also shows the estimated reservation and hard cost ceiling before submission. The operator can cancel active work. Each logical trial has its own lock and evidence. It also has a separate outcome and retry history. Physical Jobs may group trials when the launch policy permits it.

Benchmark tasks run only on Hugging Face infrastructure. V1 does not accept user datasets or arbitrary task uploads. Complete sessions and worker evidence stay private. Public views contain normalized results, public provenance, and explicitly approved trace data only.

## Current foundation

The current system already includes:

- a hosted TypeScript control service and React web application.
- approved profiles for each supported input.
- generic Harbor preparation and execution workers.
- campaign submission and budget admission.
- cost display and cancellation.
- recovery and publication.
- capability-scoped worker and Sandbox operations.
- Pi and Terminal-Bench 2.1 profiles.

Benchmark and model names must remain configuration data. The same rule applies to harness names. Harbor resolves benchmark tasks and trial locks. Harbor-HF controls Hugging Face resources and budgets. It also owns evidence, recovery, and publication.

## Next work

### Complete the production proof

Deploy the current main revision to the existing control Space and run the corrected two-task Terminal-Bench 2.1 canary. A valid canary must reach the selected harness and model, record nonzero model usage, retain provider evidence, verify every prepared record, close every Sandbox, reconcile cost, and publish durable results.

After the canary passes, run the approved five-trial campaign with the same locked inputs and control path.

### Classify infrastructure failures

Infrastructure failures must not become zero-reward model results. The generic worker and control service will classify failures in these areas:

- source or dependency download.
- Job or Sandbox provisioning.
- container and task setup.
- inference provider transport or service availability.
- verifier infrastructure and external dependencies.
- cleanup and control-service operations.

Each failure record states whether the cause is transient or deterministic. It states whether the failure affects one task or shared work. It also states whether the immutable retry policy permits a replacement. A deterministic shared defect stops related new work. Semantic and verifier outcomes remain terminal model results. Refusals and benchmark outcomes are also terminal.

### Add Terminus 2

Add Terminus 2 as a pinned Harbor harness profile that uses the same preparation and execution workers as Pi. The profile must preserve its native session output and a valid ATIF trace when the harness provides one. If conversion is required, the shared evidence and publication path performs it.

A second benchmark and a second harness must pass through the same worker entry points without a new package script, API route, or control branch.

### Publish to Harbor Hub

Harbor Hub publication starts from the verified canonical result. The publisher first validates private evidence and creates the normalized Harbor-HF result. It then derives the Harbor Hub submission and ATIF trace from the same immutable inputs.

Both destinations receive durable publication receipts. Trial workers do not write directly to either public destination.

### Seed the public catalog

After the production proof passes, run a small set of reviewed benchmark and harness combinations. These runs will test result comparison, public provenance, trace display, infrastructure-failure reporting, and the accuracy of cost estimates.

## Deferred work

The following work is outside v1:

- user-provided datasets and arbitrary task uploads.
- arbitrary Docker harness images.
- free-form deployment configuration that bypasses approved profiles.
- public raw sessions or private worker evidence.
- general public submission with user-managed compute credentials.
- automated private integrity adjudication.

These features can be added after the fixed-profile path is reliable and its cost and failure behavior are measured.

## Completion criteria

V1 is ready when:

- the two-task canary and approved five-trial campaign complete through the hosted control path.
- infrastructure failures are recorded as typed operational outcomes instead of false model scores.
- Pi and Terminus 2 use the same generic Harbor job path.
- required native sessions and ATIF traces verify.
- Harbor-HF and Harbor Hub publications derive from one canonical result.
- the web application shows immutable selections and estimated cost.
- the same interface shows the hard ceiling and progress.
- cancellation and final result views work.
- raw evidence remains private and every public object passes the privacy checks.

## Related documents

- [Control service](CONTROL_SERVICE.md)
- [Control service implementation plan](2026-08-16-harbor-hf-control-service-plan.md)
- [General Harbor job path](2026-08-18-general-harbor-job-path-plan.md)
- [Harbor compatibility contract](harbor-integration-contract.md)
- [Result publication](result-publication.md)
