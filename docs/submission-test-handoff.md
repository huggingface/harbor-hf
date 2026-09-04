> Historical pre-integration design; superseded by [execution-disabled integration](execution-disabled-integration.md). Do not use these instructions to launch or deploy.

# Submission UI test handoff

This milestone adds hosted-result submission and admin approval, not external
Harbor bundle uploads or user-funded execution. No deployment, remote smoke,
credential change, or real public result publication was performed.

## Test after deployment

Use the existing canonical Space and Bucket, retaining their existing secrets.
Do not create another resource or token. Follow the existing installer runbook;
this document is not an alternative deployment procedure.

1. Sign in as an ordinary HF user. With an initialized ACL, the sidebar should
   show Leaderboard and Submissions, but no Admin section. System, Run, Job,
   Workbench, and review API access must remain forbidden.
2. Open Submissions. An identity without eligible hosted results sees an honest
   empty state. Users can only submit results originally launched under their
   identity; this milestone does not grant them launch permission. Operators
   can submit eligible results across the installation.
3. For a newly finalized, clean, fully scored, final-role hosted result, select
   it and inspect the exact public fields. Submission stays disabled until the
   user explicitly consents. Submitting queues review and does not execute work
   or immediately expose a leaderboard row.
4. As an operator, open Submissions and inspect the pending row's exact metadata.
   Approval requires the separate privacy/consent checkbox and explicit final
   confirmation. Reject also requires confirmation. A decision is immutable.
   Do not publish test data containing private identifiers.
5. Reload or sign in from another browser. Submission and decision state must
   survive; the private Bucket is authoritative. Only approved eligible rows
   appear on the public leaderboard. No user Bucket token is required.
6. Disable control writes to check that submission and review are rejected.
   Readers cannot submit or approve even when writes are enabled.

External upload controls are deliberately absent. A plain result JSON or checksum
cannot prove hosted execution; see [the boundary and proposed validation
contract](leaderboard-submissions.md#harbor-boundary-and-deferred-external-intake).

## Existing-result compatibility

There is no grandfathering of public leaderboard rows: exact admin approval is
required. New result catalogs freeze observed cost so consent cannot race a live
spend update. Legacy catalogs without this field are not offered for submission.
An ordinary publication retry adopts its existing immutable receipt and does
**not** upgrade those catalogs. A separately reviewed, no-execution migration
from immutable published evidence would be needed for legacy results; none is
implemented here. Do not rerun a valid benchmark simply to migrate its metadata.

## Verification limits

Local verification: 707 unit/integration tests and 10 browser tests pass.
Formatting, lint, type checks, build, generated contracts, dependency-tree
consistency, and the public privacy scan pass. Browser screenshots were inspected
at desktop and mobile sizes. Coverage includes ownership, limited submitter
access, CSRF, disabled writes, explicit consent, stale preview rejection,
immutable decisions, snapshot recovery, and mobile layout.

The repository-wide coverage threshold already fails on the prior committed
source, verified in an isolated checkout; this change does not waive it. The
required Slophammer baseline and mutation script are also absent (mutation
retirement is recorded in project authorization). Dependency auditing needs a
successful registry response. These checks must be resolved before calling this
a fully verified release; no check threshold was lowered or disabled.
