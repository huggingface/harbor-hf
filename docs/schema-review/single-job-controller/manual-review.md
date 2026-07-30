# Controller schema manual review

Schemator reviewed `schemas/campaign-plan-v1alpha1.schema.json` with the project context in `context.md`. The command was:

```text
schemator run --source schemas/campaign-plan-v1alpha1.schema.json --context docs/schema-review/single-job-controller/context.md --out docs/schema-review/single-job-controller/run --max-iterations 4 --strategy codex --codex-model gpt-5.6-terra --codex-timeout-ms 120000 --codex-concurrency 4
```

The run stopped without convergence after four iterations. Its initial graph, candidate final graph, aggregate decisions, reductions, patches, graph diff, and final report are retained under `run/`.

No Schemator proposal was applied to the runtime schema. The proposed removals and derived-only fields conflict with the immutable campaign contract: campaign locks must remain self-describing and independently auditable without regenerating values from mutable tooling. In particular, logical attempt, publication identity, counts, duration bounds, concurrency, deployment identity, and digests are required verification surfaces.

The proposed renames were also rejected:

- `max_attempts` is already scoped by `execution.controller` and matches the approved specification.
- `cell_digest` identifies the resolved matrix cell; it is not a run digest.
- `deployment` is a deployment profile ID, not a filesystem path.

The manual move proposals were rejected because they change existing runtime meaning. Wave cost estimates remain part of deployment admission and apply to retry waves as well as initial waves. Existing recovery-policy fields remain in place to preserve spend and recovery semantics.

The review did not report consistency warnings. The retained raw artifacts distinguish Schemator's candidate reductions from the final product decision.
