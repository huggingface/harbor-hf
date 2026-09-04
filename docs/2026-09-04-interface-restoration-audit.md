---
title: Interface Restoration Audit
author: Harbor-HF maintainers
date: 2026-09-04
tags: [interface, restoration, simplification]
---

# Interface restoration audit

This audit records what the Harbor-centered simplification restores, adapts, and removes. It prevents an obsolete backend contract from deciding which operator features survive.

## Source baselines

The repair first restored two exact historical baselines from `origin/main` in the commits named `fix(web): restore the interface baseline` and `fix(workbench): restore the feature baseline`.

The next implementation commit adapts those files to the current Harbor-owned run contract. The historical commits make the unmodified source available for direct comparison instead of relying on memory.

## Route comparison

| Historical route | Current route | Decision |
| --- | --- | --- |
| `/` and `/leaderboard` | `/` and redirect from `/leaderboard` | Keep the public leaderboard and polished shell. |
| `/overview` | `/overview` | Keep capacity, recent runs, and reviewed submission. Use current presets and parent Job data. |
| `/workbench` | `/workbench` | Keep Configure, Test, and Run. Compile one generic command agent into a normal Harbor run. |
| `/runs` | `/runs` | Keep sortable and filterable run data. Use the current run projection. |
| `/runs/:runId` | `/runs/:runId` | Keep run identity, progress, costs, tokens, retries, errors, parent Jobs, trials, and state controls. |
| `/runs/:runId/tasks/:taskId` | `/runs/:runId/trials/:trialName` | Replace the controller task record with Harbor's projected trial result. |
| `/jobs` | `/jobs` | Keep parent HF Job state and links to runs. Harbor owns child trial Jobs. |
| `/endpoints` | None | Remove managed Endpoint control. It is outside the simplified product. |
| `/results` and `/results/:publicationId` | None | Remove the publication catalog. The leaderboard reads eligible Harbor results directly. |
| `/profiles` | None | Remove profile records and promotion. Reviewed presets and Workbench recipes are the current inputs. |
| `/audit` | None | Remove the old controller audit log. Durable run state, parent Job observations, and Harbor output are the current evidence. |

## Retained interface elements

The current interface retains the responsive sidebar and mobile drawer, skip link, loading and error states, cards, status badges, progress display, hints, sortable data tables, public authentication boundary, desktop and mobile presentation, and safe text rendering.

The adapted pages intentionally use current fields only. They do not retain profile locks, preparation state, Endpoint state, publication state, controller phases, worker waves, or old audit records.

## Deleted-document classification

The useful current references are `README.md`, `docs/architecture.md`, `docs/CONTROL_SERVICE.md`, and `docs/agent-workbench.md`. Two detailed sources remain as clearly marked historical records: `docs/harbor-integration-contract.md` and `docs/result-field-ownership.md`.

The following deleted files are obsolete or generated artifacts. They stay deleted because their active contracts were removed, their useful boundary information is in the current references above, or they are intermediate review output rather than operator documentation.

| Deleted path | Classification and replacement |
| --- | --- |
| `docs/benchmark-source-implementation-plan.md` | Obsolete implementation plan. Harbor now resolves benchmark inputs from the submitted JobConfig and reviewed presets. See `docs/architecture.md`. |
| `docs/benchmark-sources.md` | Obsolete source and bundle contract. See the preset and JobConfig boundaries in `docs/CONTROL_SERVICE.md`. |
| `docs/catalog-cutovers/2026-07-17-primary-catalog.json` | Generated cutover artifact for the removed catalog. |
| `docs/deployment-profiling.md` | Obsolete managed-deployment profiling contract. Managed Endpoints are not part of the current service. |
| `docs/endpoint-provisioning.md` | Obsolete managed Endpoint contract. See `docs/architecture.md` for current resource ownership. |
| `docs/harbor-cookbook.md` | Obsolete profile, preparation, Endpoint, and publication workflow. See `README.md` for the current operator flow. |
| `docs/harbor-integration-refactor.md` | Superseded implementation plan. Historical integration decisions are retained in `docs/harbor-integration-contract.md`. |
| `docs/harbor-native-result-publication.md` | Obsolete publication plan. The current leaderboard projects eligible Harbor results directly. |
| `docs/HOSTED_BENCHMARK_PLATFORM.md` | Superseded broad platform design. See `docs/architecture.md`. |
| `docs/implementation-plan.md` | Superseded original implementation plan. Current behavior is in `README.md` and `docs/CONTROL_SERVICE.md`. |
| `docs/provider-agent-architecture.md` | Obsolete provider-agent and worker design. Current provider routing belongs to the parent Harbor job. |
| `docs/provider-evidence-recorder-plan.md` | Obsolete recorder plan. Harbor owns results and trajectories below the run's `job/` folder. |
| `docs/result-publication.md` | Obsolete publication and supersession contract. Publication is outside the simplified service. |
| `docs/results-viewer-release.md` | Obsolete publication viewer release plan. The public route is now the leaderboard. |
| `docs/run-spec.md` | Obsolete experiment manifest. Current submission contracts are in the generated OpenAPI document. |
| `docs/schema-reviews/2026-08-16-control-record-v1.md` | Review artifact for the removed controller record. |
| `docs/schema-reviews/2026-08-16-result-catalog-v1.md` | Review artifact for the removed result catalog. |
| `docs/schema-reviews/2026-08-16-worker-evidence-manifest-v1.md` | Review artifact for the removed worker evidence manifest. |
| `docs/schema-review/single-job-controller/context.md` | Generated schema-review input for the removed controller. |
| `docs/schema-review/single-job-controller/manual-review.md` | Generated schema-review output for the removed controller. |
| `docs/schema-review/single-job-controller/run/aggregate.iteration-1.json` | Generated schema-review artifact. |
| `docs/schema-review/single-job-controller/run/aggregate.iteration-2.json` | Generated schema-review artifact. |
| `docs/schema-review/single-job-controller/run/aggregate.iteration-3.json` | Generated schema-review artifact. |
| `docs/schema-review/single-job-controller/run/aggregate.iteration-4.json` | Generated schema-review artifact. |
| `docs/schema-review/single-job-controller/run/final-report.md` | Generated schema-review artifact for the removed controller. |
| `docs/schema-review/single-job-controller/run/graph.final.json` | Generated schema-review artifact. |
| `docs/schema-review/single-job-controller/run/graph.iteration-1.json` | Generated schema-review artifact. |
| `docs/schema-review/single-job-controller/run/graph.iteration-2.json` | Generated schema-review artifact. |
| `docs/schema-review/single-job-controller/run/graph.iteration-3.json` | Generated schema-review artifact. |
| `docs/schema-review/single-job-controller/run/graph.iteration-4.json` | Generated schema-review artifact. |
| `docs/schema-review/single-job-controller/run/patch.iteration-1.md` | Generated schema-review artifact. |
| `docs/schema-review/single-job-controller/run/patch.iteration-2.md` | Generated schema-review artifact. |
| `docs/schema-review/single-job-controller/run/patch.iteration-3.md` | Generated schema-review artifact. |
| `docs/schema-review/single-job-controller/run/patch.iteration-4.md` | Generated schema-review artifact. |
| `docs/schema-review/single-job-controller/run/project-context.md` | Generated schema-review input. |
| `docs/schema-review/single-job-controller/run/reduction.iteration-1.json` | Generated schema-review artifact. |
| `docs/schema-review/single-job-controller/run/reduction.iteration-2.json` | Generated schema-review artifact. |
| `docs/schema-review/single-job-controller/run/reduction.iteration-3.json` | Generated schema-review artifact. |
| `docs/schema-review/single-job-controller/run/reduction.iteration-4.json` | Generated schema-review artifact. |
| `docs/schema-review/single-job-controller/run/run-summary.json` | Generated schema-review artifact. |
| `docs/schema-review/single-job-controller/source.md` | Generated schema-review input for the removed controller. |
| `docs/single-job-run-controller-implementation-plan.md` | Obsolete controller implementation plan. One parent Harbor job now owns each run. |
| `docs/single-job-run-controller.md` | Obsolete controller contract. See `docs/architecture.md` for the current parent Job model. |
| `docs/token-store.md` | Obsolete local token persistence. Current credentials remain in their configured deployment stores. |
| `docs/trial-evidence-bundle.md` | Obsolete worker evidence bundle. Harbor owns result and trajectory files. See `docs/result-field-ownership.md`. |
| `docs/trial-evidence-implementation-plan.md` | Obsolete worker evidence implementation plan. |

## Completion boundary

This audit covers source and information architecture. Completion still requires the repository validation gates, reviewer result, required CI, deployment of the reviewed revision, live UI checks, and bounded canaries.
