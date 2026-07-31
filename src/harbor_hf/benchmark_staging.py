from __future__ import annotations

import hashlib
import tempfile
from collections.abc import Iterable
from pathlib import Path
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict

from harbor_hf.benchmark_bundle import (
    PreparedBenchmarkBundle,
    verify_benchmark_bundle,
)
from harbor_hf.benchmark_source import bundle_prefix, bundle_uri


class BucketStagingApi(Protocol):
    def bucket_info(self, bucket_id: str) -> object: ...

    def list_bucket_tree(
        self, bucket_id: str, prefix: str, **kwargs: object
    ) -> Iterable[object]: ...

    def get_bucket_paths_info(
        self, bucket_id: str, paths: Iterable[str], **kwargs: object
    ) -> Iterable[object]: ...

    def download_bucket_files(
        self,
        bucket_id: str,
        files: list[tuple[str | object, str | Path]],
        **kwargs: object,
    ) -> None: ...

    def batch_bucket_files(
        self,
        bucket_id: str,
        *,
        add: list[tuple[str | Path | bytes, str]],
        **kwargs: object,
    ) -> object: ...


class BenchmarkBundleReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    action: Literal["planned", "uploaded", "reused", "repaired"]
    uri: str
    content_digest: str
    manifest_sha256: str
    payload_sha256: str
    file_count: int
    total_bytes: int


def stage_benchmark_bundle(
    bundle: PreparedBenchmarkBundle,
    *,
    namespace: str,
    bucket: str,
    api: BucketStagingApi,
) -> BenchmarkBundleReceipt:
    if bucket != f"{namespace}/jobs-artifacts":
        raise ValueError("benchmark bundles must use the managed Job input bucket")
    _require_private_bucket(bucket, api)
    prefix = bundle_prefix(bundle.manifest.content_digest)
    manifest_key = f"{prefix}/bundle.json"
    payload_key = f"{prefix}/{bundle.manifest.payload.filename}"
    _validate_remote_inventory(
        bucket, api, prefix, expected={manifest_key, payload_key}
    )
    existing = {
        getattr(value, "path", ""): value
        for value in api.get_bucket_paths_info(bucket, [manifest_key, payload_key])
    }
    manifest_exists = manifest_key in existing
    payload_exists = payload_key in existing
    if manifest_exists:
        if not payload_exists:
            raise ValueError("complete benchmark bundle manifest has no payload")
        _verify_remote_bundle(bundle, bucket, api, manifest_key, payload_key)
        return benchmark_bundle_receipt(bundle, namespace, "reused")
    action: Literal["uploaded", "repaired"] = (
        "repaired" if payload_exists else "uploaded"
    )
    if payload_exists:
        _verify_remote_payload(bundle, bucket, api, payload_key)
    else:
        api.batch_bucket_files(
            bucket,
            add=[(bundle.payload_path, payload_key)],
        )
        _verify_remote_payload(bundle, bucket, api, payload_key)
    api.batch_bucket_files(
        bucket,
        add=[(bundle.manifest_path, manifest_key)],
    )
    _verify_remote_bundle(bundle, bucket, api, manifest_key, payload_key)
    return benchmark_bundle_receipt(bundle, namespace, action)


def verify_staged_benchmark_bundle(
    *,
    content_digest: str,
    manifest_sha256: str,
    namespace: str,
    bucket: str,
    api: BucketStagingApi,
) -> BenchmarkBundleReceipt:
    if bucket != f"{namespace}/jobs-artifacts":
        raise ValueError("benchmark bundles must use the managed Job input bucket")
    _require_private_bucket(bucket, api)
    prefix = bundle_prefix(content_digest)
    manifest_key = f"{prefix}/bundle.json"
    payload_key = f"{prefix}/payload.tar.zst"
    _validate_remote_inventory(
        bucket, api, prefix, expected={manifest_key, payload_key}
    )
    with tempfile.TemporaryDirectory(prefix="harbor-hf-remote-bundle-") as name:
        root = Path(name)
        api.download_bucket_files(
            bucket,
            [
                (manifest_key, root / "bundle.json"),
                (payload_key, root / "payload.tar.zst"),
            ],
            raise_on_missing_files=True,
        )
        manifest = verify_benchmark_bundle(root)
        if manifest.content_digest != content_digest:
            raise ValueError("stored benchmark bundle content digest changed")
        if _sha256(root / "bundle.json") != manifest_sha256:
            raise ValueError("stored benchmark bundle manifest digest changed")
    _validate_remote_inventory(
        bucket, api, prefix, expected={manifest_key, payload_key}
    )
    return BenchmarkBundleReceipt(
        action="reused",
        uri=bundle_uri(namespace, manifest.content_digest),
        content_digest=manifest.content_digest,
        manifest_sha256=manifest_sha256,
        payload_sha256=manifest.payload.sha256,
        file_count=sum(entry.type == "file" for entry in manifest.entries),
        total_bytes=sum(
            entry.bytes for entry in manifest.entries if entry.type == "file"
        ),
    )


def _verify_remote_bundle(
    bundle: PreparedBenchmarkBundle,
    bucket: str,
    api: BucketStagingApi,
    manifest_key: str,
    payload_key: str,
) -> None:
    prefix = manifest_key.rsplit("/", maxsplit=1)[0]
    _validate_remote_inventory(
        bucket, api, prefix, expected={manifest_key, payload_key}
    )
    with tempfile.TemporaryDirectory(prefix="harbor-hf-remote-bundle-") as name:
        root = Path(name)
        api.download_bucket_files(
            bucket,
            [
                (manifest_key, root / "bundle.json"),
                (payload_key, root / "payload.tar.zst"),
            ],
            raise_on_missing_files=True,
        )
        observed = verify_benchmark_bundle(root)
        if observed != bundle.manifest:
            raise ValueError("stored benchmark bundle conflicts with local contents")
        if (root / "bundle.json").read_bytes() != bundle.manifest_path.read_bytes():
            raise ValueError("stored benchmark bundle manifest bytes changed")
    _validate_remote_inventory(
        bucket, api, prefix, expected={manifest_key, payload_key}
    )


def _verify_remote_payload(
    bundle: PreparedBenchmarkBundle,
    bucket: str,
    api: BucketStagingApi,
    payload_key: str,
) -> None:
    with tempfile.TemporaryDirectory(prefix="harbor-hf-remote-payload-") as name:
        destination = Path(name) / "payload.tar.zst"
        api.download_bucket_files(
            bucket,
            [(payload_key, destination)],
            raise_on_missing_files=True,
        )
        if destination.stat().st_size != bundle.manifest.payload.bytes:
            raise ValueError("stored benchmark payload byte count changed")
        if _sha256(destination) != bundle.manifest.payload.sha256:
            raise ValueError("stored benchmark payload conflicts with local contents")


def benchmark_bundle_receipt(
    bundle: PreparedBenchmarkBundle,
    namespace: str,
    action: Literal["planned", "uploaded", "reused", "repaired"],
) -> BenchmarkBundleReceipt:
    return BenchmarkBundleReceipt(
        action=action,
        uri=bundle_uri(namespace, bundle.manifest.content_digest),
        content_digest=bundle.manifest.content_digest,
        manifest_sha256=bundle.manifest_sha256,
        payload_sha256=bundle.manifest.payload.sha256,
        file_count=sum(entry.type == "file" for entry in bundle.manifest.entries),
        total_bytes=sum(
            entry.bytes for entry in bundle.manifest.entries if entry.type == "file"
        ),
    )


def _validate_remote_inventory(
    bucket: str,
    api: BucketStagingApi,
    prefix: str,
    *,
    expected: set[str],
) -> None:
    observed = {
        getattr(value, "path", "")
        for value in api.list_bucket_tree(bucket, prefix=prefix, recursive=True)
    }
    if observed - {"", prefix, *expected}:
        raise ValueError("benchmark bundle prefix contains unexpected objects")


def _require_private_bucket(bucket: str, api: BucketStagingApi) -> None:
    if getattr(api.bucket_info(bucket), "private", None) is not True:
        raise ValueError(f"benchmark bundle bucket {bucket} must be private")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()
