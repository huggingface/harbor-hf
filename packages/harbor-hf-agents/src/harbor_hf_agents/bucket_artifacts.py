"""Copy native Harbor files between local execution storage and the HF Bucket."""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Coroutine
from pathlib import Path

from huggingface_hub import BucketFile, BucketFolder, HfApi

# Harbor reads only these files of an existing trial when it resumes a job
# (`Job._maybe_init_existing_job`); the parent reads `result.json` for receipts.
_RESUME_TRIAL_FILES = ("config.json", "result.json")


async def _transfer[T](operation: Coroutine[object, object, T]) -> T:
    """Join SDK work on cancellation before releasing the publication lock."""
    task = asyncio.create_task(operation)
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


class BucketArtifacts:
    """Acknowledged SDK transfers, never a mounted execution filesystem."""

    def __init__(self, api: HfApi, bucket_id: str, run_dir: Path) -> None:
        if not bucket_id or len(bucket_id.split("/")) != 2:
            raise ValueError("HARBOR_HF_BUCKET_ID must identify the artifact Bucket")
        self.api = api
        self.bucket_id = bucket_id
        self.run_dir = run_dir
        self.prefix = f"runs/{run_dir.name}"
        self.lock = asyncio.Lock()
        # Digests of the bytes that the Bucket holds for each local file, by remote
        # path. A file whose local bytes still match is not uploaded again.
        self._remote: dict[str, str] = {}
        # Folder prefixes whose complete remote file list is in `_remote`. A
        # restored trial folder holds only Harbor's resume files locally.
        self._complete: set[str] = set()

    def _children(self, relative: str) -> list[tuple[str, bool]]:
        """Names directly below a run folder path, and whether each is a folder."""
        base = f"{self.prefix}/{relative}".rstrip("/")
        children = []
        for item in self.api.list_bucket_tree(
            self.bucket_id, prefix=base, recursive=False
        ):
            if not isinstance(item, (BucketFile, BucketFolder)):
                continue
            if not item.path.startswith(base + "/"):
                continue
            name = item.path.removeprefix(base + "/").rstrip("/")
            if name and "/" not in name:
                children.append((name, isinstance(item, BucketFolder)))
        return children

    def _tree(self, relative: str) -> list[str]:
        """Remote paths of every file below a run folder path."""
        base = f"{self.prefix}/{relative}"
        return [
            item.path
            for item in self.api.list_bucket_tree(
                self.bucket_id, prefix=base, recursive=True
            )
            if isinstance(item, BucketFile) and item.path.startswith(base + "/")
        ]

    def _restore_job(self) -> tuple[list[str], list[str]]:
        """Required and optional remote paths below `job/` for Harbor's resume."""
        required: list[str] = []
        optional: list[str] = []
        for child, folder in self._children("job"):
            if not folder:
                required.append(f"{self.prefix}/job/{child}")
            elif child.startswith("."):
                # Harbor's own source caches, such as `.sources/`, in full.
                self._complete.add(f"{self.prefix}/job/{child}/")
                required += self._tree(f"job/{child}")
            else:
                optional += [
                    f"{self.prefix}/job/{child}/{name}" for name in _RESUME_TRIAL_FILES
                ]
        return required, optional

    def _restore(self) -> None:
        """Download what Harbor's resume and this worker read, not trial artifacts."""
        required: list[str] = []
        optional: list[str] = []
        for name, folder in self._children(""):
            if not folder:
                required.append(f"{self.prefix}/{name}")
            elif name == "attempt-costs":
                required += [
                    f"{self.prefix}/attempt-costs/{receipt}"
                    for receipt, nested in self._children("attempt-costs")
                    if not nested
                ]
            elif name == "job":
                job_required, optional = self._restore_job()
                required += job_required
        self._download(required, must_exist=True)
        self._download(optional, must_exist=False)

    def _download(self, targets: list[str], *, must_exist: bool) -> None:
        pairs = [
            (target, self.run_dir / target.removeprefix(f"{self.prefix}/"))
            for target in targets
        ]
        for _, path in pairs:
            path.parent.mkdir(parents=True, exist_ok=True)
        transfers: list[tuple[str | BucketFile, str | Path]] = [
            (target, path) for target, path in pairs
        ]
        if transfers:
            self.api.download_bucket_files(
                self.bucket_id, transfers, raise_on_missing_files=must_exist
            )
        for target, path in pairs:
            if path.is_file():
                self._remote[target] = _digest(path)

    async def restore(self) -> None:
        """Restore into an empty local directory; Harbor decides what to resume."""
        if self.run_dir.exists():
            raise RuntimeError("parent run directory must be fresh local storage")
        self.run_dir.mkdir(parents=True)
        await _transfer(asyncio.to_thread(self._restore))
        await self.refresh_state()

    async def refresh_state(self) -> None:
        """Read controller intent afresh, without ever uploading it back."""
        await _transfer(
            asyncio.to_thread(
                self.api.download_bucket_files,
                self.bucket_id,
                [(f"{self.prefix}/state.json", self.run_dir / "state.json")],
                raise_on_missing_files=True,
            )
        )

        state = json.loads((self.run_dir / "state.json").read_text())
        if not isinstance(state, dict) or state.get("desired_state") not in {
            "run",
            "paused",
            "cancelled",
        }:
            raise ValueError("Invalid control state in artifact Bucket")

    def _local_files(self, relative: str) -> list[tuple[str | Path | bytes, str]]:
        root = self.run_dir / relative
        prefix = f"{self.prefix}/{relative}/"
        if root.is_symlink():
            raise ValueError("artifact upload refuses symbolic links")
        files: list[tuple[str | Path | bytes, str]] = []
        for path in sorted(root.rglob("*")):
            # Harbor's global job logger receives trial messages but its native
            # scrubber covers only trial directories. Never publish that copy.
            if relative == "job" and path == root / "job.log":
                continue
            if path.is_symlink():
                raise ValueError("artifact upload refuses symbolic links")
            if path.is_file():
                target = f"{prefix}{path.relative_to(root).as_posix()}"
                files.append((path, target))
        return files

    def _upload_tree(
        self, relative: str, *, delete: bool = False, publish_result: bool = True
    ) -> None:
        """Copy exact bytes, without mtime/size-based upload skipping."""
        prefix = f"{self.prefix}/{relative}/"
        files = self._local_files(relative)
        result = next(
            (item for item in files if item[1] == prefix + "result.json"), None
        )
        if result:
            files.remove(result)
        if not publish_result:
            result = None
        present = {target for _, target in files}
        if result:
            present.add(result[1])
        removed = []
        if delete:
            removed = [
                item.path
                for item in self.api.list_bucket_tree(
                    self.bucket_id, prefix=prefix, recursive=True
                )
                if isinstance(item, BucketFile)
                and item.path.startswith(prefix)
                and item.path not in present
            ]
        if files or removed:
            self.api.batch_bucket_files(self.bucket_id, add=files, delete=removed)
            self._uploaded(files, removed)
        if delete:
            self._complete.add(prefix)
        # A result must not advertise a completed tree before its files arrive.
        if result:
            self.api.batch_bucket_files(self.bucket_id, add=[result])
            self._uploaded([result], [])

    def _uploaded(
        self, files: list[tuple[str | Path | bytes, str]], removed: list[str]
    ) -> None:
        for source, target in files:
            self._remote[target] = _digest(source)
        for target in removed:
            self._remote.pop(target, None)

    def _unchanged(self, relative: str) -> bool:
        """Whether the Bucket holds the same files and bytes as this local tree."""
        prefix = f"{self.prefix}/{relative}/"
        local = self._local_files(relative)
        targets = {target for _, target in local}
        remote = {target for target in self._remote if target.startswith(prefix)}
        if prefix in self._complete and targets != remote:
            return False
        return targets <= remote and all(
            self._remote[target] == _digest(source) for source, target in local
        )

    def _upload_receipts(self) -> None:
        """Upload new or changed cost receipts; sent receipts are not sent again."""
        files = [
            (source, target)
            for source, target in self._local_files("attempt-costs")
            if self._remote.get(target) != _digest(source)
        ]
        if files:
            self.api.batch_bucket_files(self.bucket_id, add=files)
            self._uploaded(files, [])

    def _stale_job_files(self, kept: set[str]) -> list[str]:
        """Remote files below `job/` whose local file or folder Harbor removed."""
        root = self.run_dir / "job"
        removed: list[str] = []
        for name, folder in self._children("job"):
            if folder and not (root / name).is_dir():
                removed += self._tree(f"job/{name}")
            elif not folder and name not in kept:
                removed.append(f"{self.prefix}/job/{name}")
        return removed

    def _finish_job(self) -> None:
        """Upload what changed below `job/`, remove what Harbor removed, result last."""
        root = self.run_dir / "job"
        prefix = f"{self.prefix}/job/"
        if root.is_symlink():
            raise ValueError("artifact upload refuses symbolic links")
        files = [
            (source, target)
            for source, target in self._local_files("job")
            if "/" not in target.removeprefix(prefix)
            and target != prefix + "result.json"
        ]
        result = root / "result.json"
        kept = {target.removeprefix(prefix) for _, target in files}
        if result.is_file():
            kept.add("result.json")
        removed = self._stale_job_files(kept)
        if files or removed:
            self.api.batch_bucket_files(self.bucket_id, add=files, delete=removed)
            self._uploaded(files, removed)
        for path in sorted(root.iterdir()) if root.is_dir() else []:
            if path.is_dir() and not self._unchanged(f"job/{path.name}"):
                self._upload_tree(f"job/{path.name}", delete=True)
        if result.is_file():
            self.api.batch_bucket_files(
                self.bucket_id, add=[(result, prefix + "result.json")]
            )
            self._uploaded([(result, prefix + "result.json")], [])

    async def _metadata(self, relative: str, names: tuple[str, ...]) -> None:
        if (self.run_dir / relative).is_symlink():
            raise ValueError("artifact upload refuses symbolic links")
        files: list[tuple[str | Path | bytes, str]] = []
        for name in names:
            path = self.run_dir / relative / name
            if path.is_symlink():
                raise ValueError("artifact upload refuses symbolic links")
            if path.is_file():
                files.append((path.read_bytes(), f"{self.prefix}/{relative}/{name}"))
        if files:
            await _transfer(
                asyncio.to_thread(
                    self.api.batch_bucket_files, self.bucket_id, add=files
                )
            )
            self._uploaded(files, [])

    async def metadata(self) -> None:
        """Upload native metadata bytes, not a reconstructed progress record."""
        await self._metadata("job", ("config.json", "lock.json", "result.json"))

    def _remove_result(self, trial_name: str) -> None:
        path = f"{self.prefix}/job/{trial_name}/result.json"
        if any(
            item.path == path
            for item in self.api.get_bucket_paths_info(self.bucket_id, [path])
        ):
            self.api.batch_bucket_files(self.bucket_id, delete=[path])
            self._uploaded([], [path])

    async def started(self, trial_name: str) -> None:
        """Expose native identity, never unsanitized in-flight logs or results."""
        self._check_trial_name(trial_name)
        await _transfer(asyncio.to_thread(self._remove_result, trial_name))
        await self._metadata(f"job/{trial_name}", ("config.json", "lock.json"))
        await self.metadata()

    @staticmethod
    def _check_trial_name(trial_name: str) -> None:
        if (
            not trial_name
            or Path(trial_name).name != trial_name
            or trial_name in {".", ".."}
        ):
            raise ValueError("trial name must be one path component")

    async def trial(self, trial_name: str, *, publish_result: bool = True) -> None:
        """Save a finalized trial before Harbor can discard a retry attempt."""
        self._check_trial_name(trial_name)
        await _transfer(
            asyncio.to_thread(
                self._upload_tree,
                f"job/{trial_name}",
                delete=True,
                publish_result=publish_result,
            )
        )
        # Native terminal counters must be visible before a final cost receipt
        # can ask the reconciler to stop the parent during final aggregation.
        await self.metadata()
        await _transfer(asyncio.to_thread(self._upload_receipts))

    async def finish(self) -> None:
        """Save the settled tree, then publish Harbor's aggregate result last.

        A trial folder whose files and bytes already match the Bucket, because it
        was restored or saved when its trial ended, is not uploaded again.
        """
        async with self.lock:
            await _transfer(asyncio.to_thread(self._upload_receipts))
            await _transfer(asyncio.to_thread(self._finish_job))


def _digest(source: str | Path | bytes) -> str:
    data = source if isinstance(source, bytes) else Path(source).read_bytes()
    return hashlib.sha256(data).hexdigest()
