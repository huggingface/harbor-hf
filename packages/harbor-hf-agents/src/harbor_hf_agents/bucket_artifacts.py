"""Copy native Harbor files between local execution storage and the HF Bucket."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Coroutine
from pathlib import Path

from huggingface_hub import BucketFile, HfApi


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
        self.uri = f"hf://buckets/{bucket_id}/{self.prefix}"
        self.lock = asyncio.Lock()

    async def restore(self) -> None:
        """Restore into an empty local directory; Harbor decides what to resume."""
        if self.run_dir.exists():
            raise RuntimeError("parent run directory must be fresh local storage")
        self.run_dir.mkdir(parents=True)
        await _transfer(
            asyncio.to_thread(self.api.sync_bucket, self.uri, str(self.run_dir))
        )
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
        # A result must not advertise a completed tree before its files arrive.
        if result:
            self.api.batch_bucket_files(self.bucket_id, add=[result])

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
        await _transfer(asyncio.to_thread(self._upload_tree, "attempt-costs"))

    async def finish(self) -> None:
        """Save the settled tree, then publish Harbor's aggregate result last."""
        async with self.lock:
            await _transfer(asyncio.to_thread(self._upload_tree, "attempt-costs"))
            await _transfer(asyncio.to_thread(self._upload_tree, "job", delete=True))
