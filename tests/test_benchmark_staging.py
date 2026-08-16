from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path
from types import SimpleNamespace

import pytest

from harbor_hf.benchmark_bundle import PreparedBenchmarkBundle, build_benchmark_bundle
from harbor_hf.benchmark_source import bundle_prefix
from harbor_hf.benchmark_staging import (
    stage_benchmark_bundle,
    verify_staged_benchmark_bundle,
)


class MemoryBucketApi:
    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.batches: list[list[str]] = []

    def bucket_info(self, bucket_id: str) -> object:
        assert bucket_id == "example-org/jobs-artifacts"
        return SimpleNamespace(private=True)

    def list_bucket_tree(
        self, bucket_id: str, prefix: str, **kwargs: object
    ) -> Iterable[object]:
        assert bucket_id == "example-org/jobs-artifacts"
        assert kwargs == {"recursive": True}
        return [
            SimpleNamespace(path=path)
            for path in self.files
            if path == prefix or path.startswith(prefix + "/")
        ]

    def get_bucket_paths_info(
        self, bucket_id: str, paths: Iterable[str], **kwargs: object
    ) -> Iterable[object]:
        assert bucket_id == "example-org/jobs-artifacts"
        assert kwargs == {}
        return [SimpleNamespace(path=path) for path in paths if path in self.files]

    def download_bucket_files(
        self,
        bucket_id: str,
        files: list[tuple[str | object, str | Path]],
        **kwargs: object,
    ) -> None:
        assert bucket_id == "example-org/jobs-artifacts"
        assert kwargs == {"raise_on_missing_files": True}
        for source, destination in files:
            assert isinstance(source, str)
            if source not in self.files:
                raise FileNotFoundError(source)
            path = Path(destination)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(self.files[source])

    def batch_bucket_files(
        self,
        bucket_id: str,
        *,
        add: list[tuple[str | Path | bytes, str]],
        **kwargs: object,
    ) -> object:
        assert bucket_id == "example-org/jobs-artifacts"
        assert kwargs == {}
        self.batches.append([destination for _source, destination in add])
        for source, destination in add:
            content = source if isinstance(source, bytes) else Path(source).read_bytes()
            self.files[destination] = content
        return object()


def _bundle(tmp_path: Path) -> PreparedBenchmarkBundle:
    source = tmp_path / "tasks"
    source.mkdir()
    (source / "task.toml").write_text("name='task'\n", encoding="utf-8")
    return build_benchmark_bundle(source, tmp_path / "bundle")


def _keys(bundle: PreparedBenchmarkBundle) -> tuple[str, str]:
    prefix = bundle_prefix(bundle.manifest.content_digest)
    return f"{prefix}/payload.tar.zst", f"{prefix}/bundle.json"


def test_bundle_staging_rejects_a_public_bucket(tmp_path: Path) -> None:
    bundle = _bundle(tmp_path)

    class PublicBucketApi(MemoryBucketApi):
        def bucket_info(self, bucket_id: str) -> object:
            assert bucket_id == "example-org/jobs-artifacts"
            return SimpleNamespace(private=False)

    with pytest.raises(ValueError, match="must be private"):
        stage_benchmark_bundle(
            bundle,
            namespace="example-org",
            bucket="example-org/jobs-artifacts",
            api=PublicBucketApi(),
        )


def test_bundle_upload_is_payload_first_and_manifest_last(tmp_path: Path) -> None:
    bundle = _bundle(tmp_path)
    api = MemoryBucketApi()

    receipt = stage_benchmark_bundle(
        bundle,
        namespace="example-org",
        bucket="example-org/jobs-artifacts",
        api=api,
    )

    payload_key, manifest_key = _keys(bundle)
    assert receipt.action == "uploaded"
    assert api.batches == [[payload_key], [manifest_key]]
    assert receipt.content_digest == bundle.manifest.content_digest
    assert receipt.manifest_sha256 == bundle.manifest_sha256
    verified = verify_staged_benchmark_bundle(
        content_digest=bundle.manifest.content_digest,
        manifest_sha256=bundle.manifest_sha256,
        namespace="example-org",
        bucket="example-org/jobs-artifacts",
        api=api,
    )
    assert verified.action == "reused"
    assert verified.uri.endswith(bundle_prefix(bundle.manifest.content_digest))
    assert verified.file_count == 1


def test_complete_bundle_is_verified_and_reused_without_upload(tmp_path: Path) -> None:
    bundle = _bundle(tmp_path)
    api = MemoryBucketApi()
    stage_benchmark_bundle(
        bundle,
        namespace="example-org",
        bucket="example-org/jobs-artifacts",
        api=api,
    )
    api.batches.clear()

    receipt = stage_benchmark_bundle(
        bundle,
        namespace="example-org",
        bucket="example-org/jobs-artifacts",
        api=api,
    )

    assert receipt.action == "reused"
    assert api.batches == []


def test_matching_incomplete_payload_is_repaired_manifest_last(tmp_path: Path) -> None:
    bundle = _bundle(tmp_path)
    api = MemoryBucketApi()
    payload_key, manifest_key = _keys(bundle)
    api.files[payload_key] = bundle.payload_path.read_bytes()

    receipt = stage_benchmark_bundle(
        bundle,
        namespace="example-org",
        bucket="example-org/jobs-artifacts",
        api=api,
    )

    assert receipt.action == "repaired"
    assert api.batches == [[manifest_key]]


def test_bundle_prefix_rejects_unexpected_objects(tmp_path: Path) -> None:
    bundle = _bundle(tmp_path)
    api = MemoryBucketApi()
    payload_key, _manifest_key = _keys(bundle)
    prefix = payload_key.rsplit("/", maxsplit=1)[0]
    api.files[f"{prefix}/unexpected"] = b"x"

    with pytest.raises(ValueError, match="unexpected objects"):
        stage_benchmark_bundle(
            bundle,
            namespace="example-org",
            bucket="example-org/jobs-artifacts",
            api=api,
        )


def test_incomplete_or_conflicting_remote_bundle_fails_closed(tmp_path: Path) -> None:
    bundle = _bundle(tmp_path)
    payload_key, manifest_key = _keys(bundle)

    missing_payload = MemoryBucketApi()
    missing_payload.files[manifest_key] = bundle.manifest_path.read_bytes()
    with pytest.raises(ValueError, match="manifest has no payload"):
        stage_benchmark_bundle(
            bundle,
            namespace="example-org",
            bucket="example-org/jobs-artifacts",
            api=missing_payload,
        )

    conflicting_payload = MemoryBucketApi()
    conflicting_payload.files[payload_key] = b"different"
    with pytest.raises(ValueError, match="byte count changed"):
        stage_benchmark_bundle(
            bundle,
            namespace="example-org",
            bucket="example-org/jobs-artifacts",
            api=conflicting_payload,
        )
    assert conflicting_payload.batches == []


def test_verification_rejects_a_changed_manifest_digest(tmp_path: Path) -> None:
    bundle = _bundle(tmp_path)
    api = MemoryBucketApi()
    stage_benchmark_bundle(
        bundle,
        namespace="example-org",
        bucket="example-org/jobs-artifacts",
        api=api,
    )

    with pytest.raises(ValueError, match="manifest digest changed"):
        verify_staged_benchmark_bundle(
            content_digest=bundle.manifest.content_digest,
            manifest_sha256="0" * 64,
            namespace="example-org",
            bucket="example-org/jobs-artifacts",
            api=api,
        )
