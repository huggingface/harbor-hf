# Workbench configuration library

The Workbench saves named harness recipes in the existing private artifact
Bucket. Save does not launch a Job, call inference, publish a result, or bless
a recipe for shared use. The existing operator permissions apply to Save and
launch. The separate leaderboard submitter role grants no Workbench or billing
access. Administrators with direct Bucket access can inspect stored recipes.

## User workflow

1. Choose a starter, edit its commands and settings, and give it a name.
2. Select **Save configuration**. Each distinct recipe is an immutable revision;
   saving identical contents again adopts the same revision.
3. From another browser session, select the name and revision and press **Load**.
   Loading replaces the editor after confirmation and clears launch confirmation
   and setup attestation. A saved recipe still needs a successful setup test.
4. Select a reviewed benchmark configuration, confirm the existing diagnostic
   budget, and launch. The Run view links to durable results and evidence.

Never put credentials in names, commands, or literal environment values.
Existing compiler checks reject recognizable credentials; they are not a
complete secret detector. Use reviewed runtime credential injection instead.

The browser-local draft remains a convenience for unfinished edits. The named
library is stored under
`control/schema=v1/workbench/configurations/<owner-digest>/<recipe-digest>.json`.
Only the authenticated owner's library is exposed by the API. The versioned
`saved-workbench-v1.schema.json` contract reuses the existing recipe schema.

## Admin benchmark catalog

The service reads the latest immutable catalog directly from the canonical
Bucket, without a Space rebuild:

`control/schema=v1/workbench/benchmarks/<ten-digit-version>.json`

An empty installation seeds version `0000000000.json` with the existing reviewed
canary. To publish a new catalog, an administrator with Bucket write access:

1. Downloads the current catalog.
2. Edits `items`, retaining the presets that should remain selectable.
3. Increments `version` and validates against
   `packages/contracts/schemas/benchmark-catalog-v1.schema.json`.
4. Uploads the complete file at its new, zero-padded version key. Never overwrite
   an existing version. Coordinate version allocation with other administrators.
5. Reloads Workbench and checks the benchmark list before allowing execution.

The highest numbered catalog wins. An empty `items` array withdraws presets for
new submissions. An invalid newest catalog fails closed, rather than silently
restoring an older one. Publish a higher corrected version to recover.

Uploading into this admin-controlled prefix is the blessing operation. There is
no extra catalog service or approval workflow. Existing run locks retain their
resolved inputs; changed preset contents require a fresh launch confirmation.

Each item references existing promoted benchmark, model, harness-template,
deployment, and launch-policy profiles. This is deliberately a compatibility
catalog over the current runner, not a second Harbor configuration interpreter.
A new combination must satisfy the existing profile compatibility checks.
Arbitrary datasets and repetition presets still belong to the Harbor-native
cutover; this milestone does not claim to provide 1x89 or 5x89 execution support.

The `size` field is `small`, `medium`, or `large`: admin-provided workload guidance,
not a price guarantee or a replacement for existing execution safeguards.
Model pricing, task behavior, and infrastructure can substantially change cost.

## Harbor boundary

Checked Harbor revision `b37833221e27435a18d7acdd41d875cdc2831893`, especially
`src/harbor/models/job/config.py` and `src/harbor/agents/installed/fx.py`.
Also reviewed canonical upstream history through
`dcd0a7ac` on 2026-09-04: configuration composition and agent-option discovery
have landed upstream. Neither is reimplemented here. The pin and execution
workers are unchanged: this change only persists existing reviewed inputs and
makes them available through the hosted UI. The larger Harbor-native cutover
must adopt the upstream composition and option-discovery APIs.

Public result publication remains separate from saving private configurations
and execution artifacts. No new public destination is created by this feature.
