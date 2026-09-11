"""Offline contracts for acknowledged native Harbor artifact copies."""

import asyncio
import json
import threading
from pathlib import Path
from unittest.mock import Mock

import pytest
from huggingface_hub import BucketFile, HfApi

from harbor_hf_agents.bucket_artifacts import BucketArtifacts

BUCKET = "<namespace>/<artifact-bucket>"
PREFIX = "runs/<run-id>"


class MemoryBucket:
    """SDK-shaped mock with observable, synchronous transfer acknowledgements."""

    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.events: list[tuple[str, tuple[str, ...]]] = []
        self.fail_target: str | None = None
        self.api = Mock(spec=HfApi)
        self.api.sync_bucket.side_effect = self.sync
        self.api.download_bucket_files.side_effect = self.download
        self.api.batch_bucket_files.side_effect = self.batch
        self.api.list_bucket_tree.side_effect = self.list_tree
        self.api.get_bucket_paths_info.side_effect = self.paths_info

    def sync(self, source, destination):
        assert source == f"hf://buckets/{BUCKET}/{PREFIX}"
        self.events.append(("restore", ()))
        for name, data in self.files.items():
            if name.startswith(PREFIX + "/"):
                write(Path(destination), name.removeprefix(PREFIX + "/"), data)

    def download(self, bucket_id, files, *, raise_on_missing_files):
        assert bucket_id == BUCKET
        assert raise_on_missing_files is True
        for source, destination in files:
            assert isinstance(destination, Path)
            self.events.append(("download", (source,)))
            if source not in self.files:
                raise FileNotFoundError(source)
            destination.write_bytes(self.files[source])

    def batch(self, bucket_id, *, add=(), delete=()):
        assert bucket_id == BUCKET
        targets = tuple(target for _, target in add)
        self.events.append(("batch", targets))
        if self.fail_target in targets:
            raise OSError("offline upload failure")
        for source, target in add:
            assert isinstance(source, (Path, bytes))
            self.files[target] = (
                source if isinstance(source, bytes) else source.read_bytes()
            )
        for target in delete:
            self.events.append(("delete", (target,)))
            self.files.pop(target, None)

    def paths_info(self, bucket_id, paths):
        assert bucket_id == BUCKET
        return [
            BucketFile(
                type="file", path=name, size=len(self.files[name]), xetHash="0" * 64
            )
            for name in paths
            if name in self.files
        ]

    def list_tree(self, bucket_id, *, prefix, recursive):
        assert bucket_id == BUCKET
        assert recursive is True
        assert prefix.startswith(PREFIX + "/job/")
        # Deliberately include unrelated paths: the adapter must scope deletions.
        return [
            BucketFile(type="file", path=name, size=len(data), xetHash="0" * 64)
            for name, data in self.files.items()
        ] + [Mock(path=prefix + "not-a-bucket-file")]


def write(root: Path, name: str, data: bytes = b"native bytes\n") -> Path:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


@pytest.fixture
def storage(tmp_path: Path):
    remote = MemoryBucket()
    artifacts = BucketArtifacts(remote.api, BUCKET, tmp_path / "<run-id>")
    return artifacts, remote


def uploaded(remote: MemoryBucket) -> list[str]:
    return [name for kind, names in remote.events if kind == "batch" for name in names]


@pytest.mark.parametrize("bucket_id", ["", "bucket", "a/b/c"])
def test_invalid_bucket_identifier(tmp_path: Path, bucket_id):
    with pytest.raises(ValueError, match="Bucket"):
        BucketArtifacts(Mock(spec=HfApi), bucket_id, tmp_path)


@pytest.mark.asyncio
@pytest.mark.parametrize("desired_state", ["run", "paused", "cancelled"])
async def test_restore_native_tree_before_resume(storage, desired_state):
    artifacts, remote = storage
    state = json.dumps({"desired_state": desired_state}).encode()
    native = b'{ "native": [1, 2] }\n'
    remote.files = {
        f"{PREFIX}/state.json": state,
        f"{PREFIX}/run.json": b"controller-owned",
        f"{PREFIX}/job/config.json": native,
        f"{PREFIX}/job/<trial>/result.json": b"completed-native-trial",
    }
    await artifacts.restore()
    # These files are ready for Harbor's native resume, without invoking a job.
    for name, data in remote.files.items():
        assert (
            artifacts.run_dir / name.removeprefix(PREFIX + "/")
        ).read_bytes() == data
    assert remote.events == [("restore", ()), ("download", (f"{PREFIX}/state.json",))]
    assert uploaded(remote) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("existing", ["empty-directory", "directory", "file"])
async def test_restore_refuses_any_existing_destination(storage, existing):
    artifacts, remote = storage
    if existing == "file":
        artifacts.run_dir.write_bytes(b"existing")
    else:
        artifacts.run_dir.mkdir()
        if existing == "directory":
            write(artifacts.run_dir, "keep", b"existing")
    with pytest.raises(RuntimeError, match="fresh local storage"):
        await artifacts.restore()
    assert remote.api.mock_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "state",
    [
        b"{",
        b"null",
        b"[]",
        b'"run"',
        b"{}",
        b'{"desired_state":"done"}',
        b'{"desired_state":null}',
    ],
)
async def test_restore_rejects_malformed_control_state(storage, state):
    artifacts, remote = storage
    remote.files[f"{PREFIX}/state.json"] = state
    with pytest.raises(ValueError):
        await artifacts.restore()
    assert not uploaded(remote)


@pytest.mark.asyncio
async def test_restore_missing_state_is_fatal(storage):
    artifacts, remote = storage
    with pytest.raises(FileNotFoundError):
        await artifacts.restore()
    assert not uploaded(remote)


@pytest.mark.asyncio
async def test_refresh_fetches_current_state_and_does_not_trust_cached_copy(storage):
    artifacts, remote = storage
    write(artifacts.run_dir, "state.json", b'{"desired_state":"run"}')
    remote.files[f"{PREFIX}/state.json"] = b'{"desired_state":"paused"}'
    await artifacts.refresh_state()
    assert (artifacts.run_dir / "state.json").read_bytes() == remote.files[
        f"{PREFIX}/state.json"
    ]
    remote.files.clear()
    with pytest.raises(FileNotFoundError):
        await artifacts.refresh_state()
    assert not uploaded(remote)


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["started", "trial"])
@pytest.mark.parametrize(
    "name", ["", ".", "..", "../<trial>", "<trial>/child", "/absolute", "<trial>/"]
)
async def test_invalid_trial_names_rejected_before_sdk_calls(storage, method, name):
    artifacts, remote = storage
    with pytest.raises(ValueError, match="one path component"):
        await getattr(artifacts, method)(name)
    assert remote.api.mock_calls == []


@pytest.mark.asyncio
async def test_metadata_preserves_exact_native_bytes_and_omits_other_files(storage):
    artifacts, remote = storage
    data = b'{ "native": "\\u00e9", "count": 1 }\n\n'
    for name in ("config.json", "lock.json", "result.json", "job.log"):
        write(artifacts.run_dir, f"job/{name}", data)
    write(artifacts.run_dir, "state.json", b"private control")
    await artifacts.metadata()
    assert remote.files == {
        f"{PREFIX}/job/{name}": data
        for name in ("config.json", "lock.json", "result.json")
    }
    additions = remote.api.batch_bucket_files.call_args.kwargs["add"]
    assert all(isinstance(source, bytes) for source, _ in additions)


@pytest.mark.asyncio
async def test_missing_metadata_is_not_synthesized(storage):
    artifacts, remote = storage
    await artifacts.metadata()
    remote.api.batch_bucket_files.assert_not_called()


@pytest.mark.asyncio
async def test_started_deletes_stale_result_before_exposing_only_identity(storage):
    artifacts, remote = storage
    result = f"{PREFIX}/job/<trial>/result.json"
    remote.files[result] = b"stale"
    for name in (
        "config.json",
        "lock.json",
        "result.json",
        "agent/log.txt",
        "verifier/output.txt",
    ):
        write(artifacts.run_dir, f"job/<trial>/{name}")
    write(artifacts.run_dir, "job/config.json")
    await artifacts.started("<trial>")
    assert result not in remote.files
    assert remote.events[:2] == [("batch", ()), ("delete", (result,))]
    assert uploaded(remote) == [
        f"{PREFIX}/job/<trial>/config.json",
        f"{PREFIX}/job/<trial>/lock.json",
        f"{PREFIX}/job/config.json",
    ]


@pytest.mark.asyncio
async def test_trial_publishes_verifier_then_result_then_metadata_then_receipts(
    storage,
):
    artifacts, remote = storage
    for name in (
        "job/<trial>/verifier/reward.txt",
        "job/<trial>/agent/trajectory.json",
        "job/<trial>/result.json",
        "job/result.json",
        "attempt-costs/<receipt>.json",
    ):
        write(artifacts.run_dir, name)
    await artifacts.trial("<trial>")
    names = uploaded(remote)
    result = names.index(f"{PREFIX}/job/<trial>/result.json")
    assert names.index(f"{PREFIX}/job/<trial>/verifier/reward.txt") < result
    assert names.index(f"{PREFIX}/job/<trial>/agent/trajectory.json") < result
    assert (
        result
        < names.index(f"{PREFIX}/job/result.json")
        < names.index(f"{PREFIX}/attempt-costs/<receipt>.json")
    )


@pytest.mark.asyncio
async def test_finish_aggregate_is_last_after_receipts_and_entire_tree(storage):
    artifacts, remote = storage
    for name in (
        "attempt-costs/<receipt>.json",
        "job/config.json",
        "job/<trial>/result.json",
        "job/<trial>/verifier/reward.txt",
        "job/result.json",
    ):
        write(artifacts.run_dir, name)
    await artifacts.finish()
    names = uploaded(remote)
    assert names[0] == f"{PREFIX}/attempt-costs/<receipt>.json"
    assert names[-1] == f"{PREFIX}/job/result.json"
    assert remote.events[-1] == ("batch", (f"{PREFIX}/job/result.json",))
    assert len(names) == 5


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "method,target",
    [
        ("trial", "job/<trial>/verifier/reward.txt"),
        ("trial", "job/<trial>/result.json"),
        ("finish", "attempt-costs/<receipt>.json"),
        ("finish", "job/<trial>/verifier/reward.txt"),
        ("finish", "job/result.json"),
    ],
)
async def test_upload_failure_propagates_without_publishing_completion(
    storage, method, target
):
    artifacts, remote = storage
    for name in (
        "attempt-costs/<receipt>.json",
        "job/<trial>/verifier/reward.txt",
        "job/<trial>/result.json",
        "job/result.json",
    ):
        write(artifacts.run_dir, name)
    remote.fail_target = f"{PREFIX}/{target}"
    with pytest.raises(OSError, match="offline upload failure"):
        if method == "trial":
            await artifacts.trial("<trial>")
        else:
            await artifacts.finish()
    assert f"{PREFIX}/job/result.json" not in remote.files
    if method == "trial":
        assert f"{PREFIX}/job/<trial>/result.json" not in remote.files
        assert f"{PREFIX}/attempt-costs/<receipt>.json" not in remote.files
    assert not artifacts.lock.locked()


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["trial", "finish"])
async def test_removals_are_scoped_and_control_files_never_overwritten(storage, method):
    artifacts, remote = storage
    protected = {
        f"{PREFIX}/state.json": b"control state",
        f"{PREFIX}/run.json": b"control run",
        "runs/<other-run>/job/result.json": b"other run",
        f"{PREFIX}/job-extra/stale": b"prefix sibling",
    }
    if method == "trial":
        protected[f"{PREFIX}/job/<other-trial>/result.json"] = b"other trial"
    remote.files.update(protected)
    stale = f"{PREFIX}/job/<trial>/stale.txt"
    remote.files[stale] = b"stale"
    write(artifacts.run_dir, "state.json", b"must not upload")
    write(artifacts.run_dir, "run.json", b"must not upload")
    write(artifacts.run_dir, "job/<trial>/config.json")
    if method == "trial":
        await artifacts.trial("<trial>")
    else:
        await artifacts.finish()
    assert stale not in remote.files
    assert all(remote.files[name] == data for name, data in protected.items())
    assert [names for kind, names in remote.events if kind == "delete"] == [(stale,)]


@pytest.mark.asyncio
async def test_same_size_changed_content_always_uploads(storage):
    artifacts, remote = storage
    path = write(artifacts.run_dir, "job/<trial>/config.json", b"aaaa")
    await artifacts.trial("<trial>")
    path.write_bytes(b"bbbb")
    await artifacts.trial("<trial>")
    await artifacts.trial("<trial>")
    target = f"{PREFIX}/job/<trial>/config.json"
    assert remote.files[target] == b"bbbb"
    assert uploaded(remote).count(target) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["root", "file", "directory", "dangling"])
async def test_tree_symlinks_refused_before_any_upload(storage, tmp_path: Path, kind):
    artifacts, remote = storage
    outside = write(tmp_path, "outside/payload", b"must not follow")
    root = artifacts.run_dir / "job/<trial>"
    root.parent.mkdir(parents=True)
    if kind == "root":
        root.symlink_to(outside.parent, target_is_directory=True)
    else:
        root.mkdir()
        target = outside.parent if kind == "directory" else outside
        if kind == "dangling":
            target = tmp_path / "missing"
        (root / "link").symlink_to(target, target_is_directory=kind == "directory")
    with pytest.raises(ValueError, match="symbolic links"):
        await artifacts.trial("<trial>")
    remote.api.batch_bucket_files.assert_not_called()
    remote.api.list_bucket_tree.assert_not_called()


@pytest.mark.asyncio
async def test_cancellation_joins_sdk_thread_before_releasing_publication_lock(storage):
    artifacts, remote = storage
    write(artifacts.run_dir, "attempt-costs/<receipt>.json")
    entered = threading.Event()
    release = threading.Event()
    finished = threading.Event()
    acquired = asyncio.Event()

    def blocking_batch(*args, **kwargs):
        entered.set()
        if not release.wait(timeout=5):
            raise TimeoutError("test did not release SDK thread")
        remote.batch(*args, **kwargs)
        finished.set()

    async def contender():
        async with artifacts.lock:
            assert finished.is_set()
            acquired.set()

    remote.api.batch_bucket_files.side_effect = blocking_batch
    task = asyncio.create_task(artifacts.finish())
    waiter = None
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        task.cancel()
        waiter = asyncio.create_task(contender())
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert not task.done()
        assert artifacts.lock.locked()
        assert not acquired.is_set()
        assert not finished.is_set()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=5)
        await asyncio.wait_for(waiter, timeout=5)
        assert finished.is_set()
        assert acquired.is_set()
        assert not artifacts.lock.locked()
    finally:
        release.set()
        await asyncio.gather(
            task, *([waiter] if waiter else []), return_exceptions=True
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["metadata", "started"])
async def test_metadata_symlinks_refused(storage, tmp_path: Path, method):
    artifacts, remote = storage
    outside = write(tmp_path, "outside/native.json", b"must not follow")
    relative = "job/config.json" if method == "metadata" else "job/<trial>/config.json"
    link = artifacts.run_dir / relative
    link.parent.mkdir(parents=True)
    link.symlink_to(outside)
    with pytest.raises(ValueError, match="symbolic links"):
        if method == "metadata":
            await artifacts.metadata()
        else:
            await artifacts.started("<trial>")
    assert not uploaded(remote)


@pytest.mark.asyncio
@pytest.mark.parametrize("target", ["job/config.json", "attempt-costs/<receipt>.json"])
async def test_late_trial_upload_failure_propagates_and_stops_publication(
    storage, target
):
    artifacts, remote = storage
    for name in (
        "job/<trial>/result.json",
        "job/config.json",
        "attempt-costs/<receipt>.json",
    ):
        write(artifacts.run_dir, name)
    remote.fail_target = f"{PREFIX}/{target}"
    with pytest.raises(OSError, match="offline upload failure"):
        await artifacts.trial("<trial>")
    # Already acknowledged native trial evidence is retained, not rolled back.
    assert f"{PREFIX}/job/<trial>/result.json" in remote.files
    assert f"{PREFIX}/{target}" not in remote.files
    assert f"{PREFIX}/attempt-costs/<receipt>.json" not in remote.files
    assert remote.events[-1] == ("batch", (f"{PREFIX}/{target}",))


@pytest.mark.asyncio
async def test_restore_sdk_failure_propagates_without_refresh(storage):
    artifacts, remote = storage
    remote.api.sync_bucket.side_effect = OSError("offline restore failure")
    with pytest.raises(OSError, match="offline restore failure"):
        await artifacts.restore()
    remote.api.download_bucket_files.assert_not_called()
    remote.api.batch_bucket_files.assert_not_called()


@pytest.mark.asyncio
async def test_started_delete_failure_prevents_metadata_publication(storage):
    artifacts, remote = storage
    write(artifacts.run_dir, "job/<trial>/config.json")
    remote.files[f"{PREFIX}/job/<trial>/result.json"] = b"old result"
    remote.api.batch_bucket_files.side_effect = OSError("offline deletion failure")
    with pytest.raises(OSError, match="offline deletion failure"):
        await artifacts.started("<trial>")
    remote.api.batch_bucket_files.assert_called_once_with(
        BUCKET, delete=[f"{PREFIX}/job/<trial>/result.json"]
    )


@pytest.mark.asyncio
async def test_uncertain_retry_result_is_withheld_until_settled_final_copy(storage):
    artifacts, remote = storage
    write(artifacts.run_dir, "job/trial/result.json", b'{"exception_info": {}}')
    write(artifacts.run_dir, "job/trial/verifier/reward.txt", b"0\n")
    write(artifacts.run_dir, "job/result.json", b'{"finished_at": null}')
    remote.files[f"{PREFIX}/job/trial/result.json"] = b"old result"
    await artifacts.trial("trial", publish_result=False)
    assert f"{PREFIX}/job/trial/result.json" not in remote.files
    assert remote.files[f"{PREFIX}/job/trial/verifier/reward.txt"] == b"0\n"
    await artifacts.finish()
    assert remote.files[f"{PREFIX}/job/trial/result.json"] == b'{"exception_info": {}}'


@pytest.mark.asyncio
async def test_started_does_not_delete_nonexistent_results(storage):
    artifacts, remote = storage
    await artifacts.started("new-trial")
    remote.api.batch_bucket_files.assert_not_called()
    remote.api.get_bucket_paths_info.assert_called_once_with(
        BUCKET, [f"{PREFIX}/job/new-trial/result.json"]
    )


@pytest.mark.asyncio
async def test_unscrubbed_global_job_log_is_not_published(storage):
    artifacts, remote = storage
    write(artifacts.run_dir, "job/job.log", b"synthetic sensitive message")
    write(artifacts.run_dir, "job/trial/trial.log", b"scrubbed log")
    remote.files[f"{PREFIX}/job/job.log"] = b"old global log"
    await artifacts.finish()
    assert f"{PREFIX}/job/job.log" not in remote.files
    assert remote.files[f"{PREFIX}/job/trial/trial.log"] == b"scrubbed log"
