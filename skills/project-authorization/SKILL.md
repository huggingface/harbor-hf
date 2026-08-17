---
name: project-authorization
description: Ask for project approval before starting repository work, record the approved scope in the control-plane project file indexed by canonical repository slug, and recover authorization after compaction or session changes. Use before implementing, deploying, publishing, merging, spending, moving credentials, cutting over, or retiring resources for a repository.
---

# Project authorization

Use the control-plane repository's project files as the durable source of work authorization. Do not rely on conversation summaries as approval evidence.

## Locate the project file

Resolve the control-plane repository root from this skill's directory. Project authorization files always live in that repository, even when the approved work changes another repository.

Resolve the repository selected by the user. Otherwise, use the canonical `origin` remote of the repository being changed.

Derive its canonical slug as `<owner>/<repository>`. Strip the transport prefix and a trailing `.git`. Ignore local checkout and worktree directory names. Do not use the branch name.

The project file is:

```text
projects/<owner>/<repository>.md
```

Use lowercase path components. Preserve the canonical slug and HTTPS repository link in the file frontmatter.

When work spans multiple repositories, authorize each repository in its own project file. Approval for one repository does not authorize another.

## Gate work at the beginning

Before starting implementation or any external mutation:

1. Read the project file.
2. Compare the requested work with its current approved scope and limits.
3. Identify every expected credential transfer, paid or recurring resource, deployment, publication, merge, cutover, destructive action, and private-data boundary.
4. If the file is missing or the scope is not already approved, prepare one consolidated authorization request and ask the user before starting.
5. After direct approval, record it in the project file and commit that file before beginning the approved work.

Read-only inspection and preparing the authorization record are allowed before approval. Code changes and paid work are not. Credential movement and remote mutation are also barred. Do not publish, merge, deploy, or perform destructive actions.

Do not infer approval from a desired outcome, implementation plan, queued prompt, previous summary, or a statement that approval probably happened. Record only a direct user decision or an approval already present in the project file.

## Project file format

Use this structure:

```markdown
---
schema_version: v1
slug: <owner>/<repository>
repository: https://github.com/<owner>/<repository>
default_branch: <branch>
---

# <Project name>

## Current authorization

Status: pending

### Scope

- <work to perform>

### Limits

- <cost, time, credential, deployment, or safety boundary>

## Approval history

### <YYYY-MM-DD>

- Pending: <approval requested>
```

Allowed status values are `pending`, `approved`, `revoked`, and `completed`.

After approval:

- change `Status` to `approved`.
- add `Approved at: <RFC 3339 timestamp>`.
- keep the approved scope and limits concrete.
- append a dated approval-history entry.
- commit the authorization before other work.

Use logical names and public placeholders. Never record secret values, authorization headers, private resource IDs, credential display names, local paths, private topology, or other operator-specific identifiers in this public repository.

## Resume and amendments

After compaction or session resume, read the project file before asking again. Apply the same rule after a handoff. Continue without re-asking when the requested action is clearly inside an active approved scope.

When scope or limits change:

1. Append a pending amendment to the approval history.
2. Set the current status to `pending` if the new work cannot be separated safely.
3. Ask for the additional approval before performing the new work.
4. Record and commit the decision additively.

Do not rewrite an earlier approval to make broader work appear authorized. A revoked, expired, completed, or exceeded authorization cannot admit new work.

## Completion

When the approved work is complete, set the status to `completed` and append the completion date. Preserve the approval history and Git history.
