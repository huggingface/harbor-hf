---
schema_version: v1
slug: harbor-framework/terminal-bench-2-1
repository: https://github.com/harbor-framework/terminal-bench-2-1
default_branch: main
---

# Terminal-Bench task repair

## Current authorization

Status: approved

Approved at: 2026-09-10T08:33:36.655293+00:00

### Scope

- Direct approval: repair the qemu-startup and qemu-alpine-ssh task containers for a separately identified 2.1-fixed diagnostic revision, and prepare a two-task, two-attempt smoke preset.
- Prepare local task Dockerfile and environment documentation changes using Bookworm and netcat-openbsd; build local images and validate dependencies, reference solutions and unchanged verifiers without model inference. Preserve task instructions, guest artifacts and scoring assertions.
- Local task commits and evidence/provenance preparation are approved. Preserve the original pinned source, task images and historical results.

### Limits

- Exact source/image publication destinations require confirmation before publishing. Upstream push permission is currently unavailable. Do not create a repository, fork, registry package, Bucket or Space implicitly.
- No upstream issue/PR, merge, deployment, remote Jobs, benchmark/model execution, inference, credential copying, or historical result edits. Reference-solution tests in local containers are permitted; no credentials may enter them.

## Approval history

### 2026-09-09

- User approved the task repair and smoke definition; local implementation and no-inference validation are the separable first stage. Public source and image publication remain pending exact destinations.

### Local validation recorded on 2026-09-09

- Applied only the two approved Dockerfile substitutions and infrastructure
  README notes. Instructions, task configuration, ISO URL, disk, ports,
  reference solutions and scoring tests are unchanged.
- Both linux/amd64 local images built successfully. Native Harbor Docker oracle
  execution passed once per task: one unchanged verifier test each, reward 1,
  no exceptions and no retries; both kernel assertions passed. Each container
  was limited to one CPU and 4 GiB RAM without host KVM, privileged mode,
  published ports, Docker socket or credentials. Trial containers were removed.
- Compared canonical benchmark main with the original pin: neither task has an
  upstream repair. Checked Harbor hf_sandbox.py and Docker/oracle/config source
  at the actual integration pin dcd0a7ac, plus history through 191d1b98; hosted
  execution still requires prebuilt images. No Harbor-HF worker code was added.
- Local preparation is validated, not published. Existing task image references
  deliberately remain unchanged and do not contain the repair. Exact source and
  image publication, immutable image references and the runnable diagnostic
  revision remain pending; the overall authorization stays open.

### Local provenance amendment (2026-09-09)

- Direct user approval permits local task.toml immutable image references and README provenance after verified publication to the exact existing GHCR package authorized in the Harbor-HF project record.
- Wait for upstream maintainers. No benchmark source publication, fork, issue, PR or contact is authorized. Diagnostic drafts remain non-launchable pending available repaired upstream source.

### Fork publication amendment (2026-09-09)

- Direct approval supersedes the source-publication hold only for the public
  fork https://github.com/evalstate/terminal-bench-2-1, branch `qemu-fixed`.
  The canonical repository remains read-only: no push, issue, PR or contact.
- Scope, inventory exception and exact public identifier approval are recorded
  in the Harbor-HF project amendment and the independently indexed fork project.
