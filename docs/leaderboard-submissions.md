# Hosted leaderboard submissions

Internal result publication and public leaderboard approval are different actions.
The existing publisher still verifies evidence, normalizes results, and writes the
private catalog and publication receipt. None of those actions grants public
visibility. Diagnostic, mixed, incomplete, unscored, and non-clean catalogs remain
ineligible, even with an operator request.

## Access

With a configured private ACL, a verified identity absent from both lists receives
`submitter`, not `reader`. Without an ACL, authentication fails closed. Existing
operator and reader permissions are unchanged. Ordinary submitters can use only:

- `GET /api/v1/auth/session`
- `POST /auth/logout`
- `GET /api/v1/leaderboard` (also public)
- `GET /api/v1/leaderboard/candidates`
- `GET /api/v1/leaderboard/submissions`
- `POST /api/v1/leaderboard/submissions`

This is an exact method/path allowlist, not a prefix grant. It does not grant
Runs, locks, Results, profiles, system, events, audit, capacity, Jobs, Endpoints,
Workbench, or account-library access. Static assets and OAuth login/callback
remain reachable. An operator can review; a reader cannot submit or review.

Candidates belong to the original Run request Actor (the lock Actor when no
request exists). An operator can see all candidates. Submission ownership checks
precede eligibility checks: nonexistent and wrong-owner Runs both return 404.
A submitter cannot launch a Run through these routes. An empty candidate list
means there is currently no eligible hosted result owned by that identity.

## API contract for the frontend

Generated OpenAPI and `apps/control-web/src/generated/api.ts` are authoritative.
All success responses below are HTTP 200. Session responses now include
`actor.role: operator | reader | submitter`; they never include the OAuth subject.

`GET /api/v1/leaderboard/candidates` returns:

```text
{ items: [{ run_id, publication_id, catalog_digest, public_row }] }
```

`public_row` contains the existing leaderboard fields without computed `rank`
and `pareto`: configuration_digest, run_id, publication_id, published_at,
benchmark, model, harness, inference_provider, reasoning_effort, harbor_version,
trial_count, task_count, scored_task_count, primary_metric_name,
primary_metric_value, primary_metric_unit, observed_microusd. It contains no
Actor, private Bucket key, evidence payload, or infrastructure identity.

`POST /api/v1/leaderboard/submissions` accepts exactly:

```json
{ "run_id": "<run-id>", "catalog_digest": "sha256:<digest>", "confirmed": true }
```

Cost is frozen in the immutable catalog, not read from live spend during consent
or review. Legacy catalogs without frozen cost are not candidates. Publication
retry adopts the existing receipt; it does not upgrade it. Supporting legacy
results needs a separately reviewed no-execution migration from immutable
evidence, not a guessed value or a rerun.

The server requires the previewed digest to match the newest eligible catalog
for that Run (otherwise 409), and freezes its
exact evidence binding. It returns one submission summary:

```text
{ id, run_id, publication_id, catalog_digest, created_at,
  status: pending | approved | rejected }
```

`GET /api/v1/leaderboard/submissions` returns `{ items: [summary] }`. Submitters
see their own submission records; operators see all. Candidate and submission
lists currently return all scoped items, without pagination. Match review
previews by **catalog_digest and publication_id**, never Run ID alone.

`POST /api/v1/leaderboard/submissions/{id}/review` accepts:

```json
{
  "decision": "approved",
  "confirmed": true,
  "public_metadata_confirmed": true
}
```

For rejection, `decision` is `rejected` and `public_metadata_confirmed` may be
omitted. The response is `{ id, status: approved | rejected }`.

Approval requires the operator to inspect the exact candidate public fields and
explicitly confirm that they contain no unapproved personal identity, private
namespace, topology, credential, or other private metadata, and that consent
covers those exact values on the public leaderboard. General execution approval
is not publication consent. No raw Actor identity is copied into a public row.
Do not check this confirmation automatically in the UI.

Both submission and review require session-bound `X-CSRF-Token` for browser
sessions and reject disabled control writes. Confirmed false/missing is 400;
missing privacy confirmation on approval is 400
`public_metadata_confirmation_required`; wrong-owner/missing results are 404;
ineligible owned results are 422; changed evidence or a competing decision is
409. Readers and non-operator reviewers receive 403. Existing safe error envelopes
and authentication/rate limits apply.

## Durable state and recovery

The existing private Bucket stores the canonical JSON Schema records:

- `results/schema=v1/leaderboard/submissions/<id>.json`
- `results/schema=v1/leaderboard/decisions/<id>.json`

Submission IDs derive from Run, publication, and exact catalog digest. A submission
binds catalog key/digest, lock digest, exact public-row digest, Actor, and explicit
confirmation. One immutable decision key per submission binds the submission
bytes and repeats the catalog/public-row digests. Competing decisions cannot
both win. Repeating the same decision adopts the existing record, without
changing its Actor or timestamp. No replacement decision or edit endpoint exists.

Approval rechecks the existing eligibility and published-receipt provenance
gates against the exact submitted catalog, lock, and public metadata. It calls
`refreshLeaderboardSnapshot`; it never parses Harbor output, normalizes a second
result, or executes a task. Repeating approval repairs an interrupted snapshot
write. A new catalog needs a new submission and review, even for the same Run.

Snapshot creation requires exact approved catalog, lock, and row bindings. Public
snapshot reads also verify approval bindings, including legacy snapshots; old
rows are not grandfathered. Concurrent/older snapshots contribute only
consent-bound rows, using the existing configuration winner rule. Snapshot
metadata is null when no stored snapshot exactly represents the approved view.
Records remain canonical in the Bucket; listing after a projection rebuild
recovers the same decisions without a new store or authority.

## Harbor boundary and deferred external intake

Reviewed Harbor at pinned revision
`b37833221e27435a18d7acdd41d875cdc2831893`, including
`src/harbor/hub/leaderboards.py`, `src/harbor/models/job/result.py`, and
`src/harbor/models/trial/result.py`, plus upstream history through the fetched
main revision. Harbor's curated-leaderboard client targets Harbor Hub APIs; it
does not implement this Space's ACL, canonical-Bucket review records, or consent
policy. Its result models are native result structures, not proof that arbitrary
external bundles were executed by the hosted service. This feature needs no
worker/Harbor behavior or pin change.

External bundle ingestion is deferred. A public Harbor validation boundary for
untrusted bundles must establish bounded artifact inventory, native config/lock/
result consistency, and provenance without treating uploaded claims as verified
hosted execution. Propose that validation contract upstream before implementing
an uploader here; no upstream issue or change is authorized by this milestone.
No upload route, archive extractor, or external-result normalizer is added.
