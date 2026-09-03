# Trial worker image

Preparation and execution Jobs use this reviewed worker image, never the
benchmark task image as the host image. The image contains pinned Python 3.12,
the pinned Harbor commit, and the local `harbor-hf-agents` package.

Profiles invoke the installed workers directly:

```text
python -m harbor_hf_agents.support.control_prepare_worker
python -m harbor_hf_agents.support.control_trial_job_worker
```

## Task-image boundary

The execution worker uses `skopeo` and `umoci` to verify and unpack the locked
task image in a root-owned workspace. Before extraction it:

- verifies compressed blob sizes and digests;
- bounds expanded bytes and entry counts for gzip, tar, and Zstandard layers;
- rejects special files and unsafe paths;
- strips setuid, setgid, and file capabilities; and
- reserves Job-local space for extraction and cleanup.

PRoot presents the unpacked rootfs and emulates the task-image user. It is not
treated as a security boundary. The image builds PRoot 5.4 from checksummed
upstream source because older Debian Bookworm packages cannot translate
required `statx` calls. Worker preflight rejects PRoot versions older than 5.3.

`setpriv` launches task and agent commands as real UID/GID 60000 with no
supplementary groups, capabilities, or privilege escalation. Host `/run`,
`/tmp`, worker files, capabilities, and credential files are not mounted into
the task rootfs. The worker preflight proves that UID 60000 cannot read the
root worker environment or a root-owned probe file.

The task sees the host `/proc` metadata needed by normal tools and `/dev/pts`
for interactive agent terminals. Agent descendants are stopped before the
worker freezes the post-agent workspace and Harbor starts the verifier. The
verifier intentionally uses that frozen task filesystem.

## Direct inference

Preparation Jobs receive no inference credential. An execution Job receives
`HF_INFERENCE_TOKEN` only when its immutable deployment resolves an inference
upstream. Harbor's resolved `AgentConfig.env` supplies that credential,
upstream URL, timeout, and output-token settings to the reviewed agent plugin.
The plugin configures its native runtime and calls the upstream directly.

The control credential is forbidden in every Job. Jobs also receive no
writable mount of the canonical artifact Bucket. Evidence and terminal
receipts return through a short-lived signed capability.

## Build and publication

Build and inspect locally:

```bash
docker build -f deploy/trial-worker/Dockerfile -t <trial-worker-image> .
docker image inspect <trial-worker-image> --format '{{json .RepoDigests}}'
```

The `Publish trial worker` workflow publishes only the selected commit's
`linux/amd64` image and does not move a mutable `latest` tag. Record the
resulting registry digest in every deployment profile.

Before updating a profile, review installed Python, Harbor, `git`, `proot`,
`setpriv`, `skopeo`, `umoci`, and `zstd` versions from the build log. Test:

- real-UID preflight;
- task-image verification and extraction limits;
- PRoot execution;
- direct inference environment resolution;
- absence of inference credentials from preparation and no-inference Jobs;
- agent process cleanup;
- workspace freeze and verifier ordering; and
- scoped evidence upload on the target HF Job hardware.

Publish only the reviewed image and pin its immutable digest before deployment.
