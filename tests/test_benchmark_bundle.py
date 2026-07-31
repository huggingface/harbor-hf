from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import pytest
import zstandard

import harbor_hf.benchmark_bundle as benchmark_bundle
from harbor_hf.benchmark_bundle import (
    BenchmarkBundleManifest,
    BundleDirectory,
    BundleEntry,
    BundleFile,
    BundlePayload,
    benchmark_bundle_json_schema,
    build_benchmark_bundle,
    bundle_content_digest,
    bundle_manifest_bytes,
    extract_benchmark_bundle,
    validate_benchmark_bundle,
    verify_benchmark_bundle,
)


def _source(root: Path) -> Path:
    source = root / "tasks"
    (source / "nested").mkdir(parents=True)
    (source / "dataset.toml").write_text("name = 'local'\n", encoding="utf-8")
    executable = source / "nested" / "verify.sh"
    executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    executable.chmod(0o751)
    return source


def test_bundle_is_deterministic_and_extracts_exact_contents(tmp_path: Path) -> None:
    first_source = _source(tmp_path / "first")
    second_source = _source(tmp_path / "second")
    first = build_benchmark_bundle(first_source, tmp_path / "bundle-one")
    second = build_benchmark_bundle(second_source, tmp_path / "bundle-two")

    assert first.manifest == second.manifest
    assert first.manifest_sha256 == second.manifest_sha256
    assert first.payload_path.read_bytes() == second.payload_path.read_bytes()
    assert str(first_source) not in first.manifest_path.read_text(encoding="utf-8")

    destination = tmp_path / "extracted"
    previous_umask = os.umask(0o077)
    try:
        assert extract_benchmark_bundle(first.bundle_root, destination) == destination
    finally:
        os.umask(previous_umask)
    assert (destination / "dataset.toml").read_bytes() == b"name = 'local'\n"
    assert (destination / "nested" / "verify.sh").read_bytes() == (
        b"#!/bin/sh\nexit 0\n"
    )
    assert (destination / "nested").stat().st_mode & 0o777 == 0o755
    assert (destination / "dataset.toml").stat().st_mode & 0o777 == 0o644
    assert (destination / "nested" / "verify.sh").stat().st_mode & 0o777 == 0o755
    assert verify_benchmark_bundle(first.bundle_root) == first.manifest


def test_bundle_identity_changes_with_bytes_modes_and_paths(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    file = source / "task.toml"
    file.write_text("a", encoding="utf-8")
    initial = build_benchmark_bundle(source, tmp_path / "initial")

    file.write_text("b", encoding="utf-8")
    changed_bytes = build_benchmark_bundle(source, tmp_path / "changed-bytes")
    file.chmod(0o755)
    changed_mode = build_benchmark_bundle(source, tmp_path / "changed-mode")
    file.rename(source / "renamed.toml")
    changed_path = build_benchmark_bundle(source, tmp_path / "changed-path")

    digests = {
        bundle.manifest.content_digest
        for bundle in (initial, changed_bytes, changed_mode, changed_path)
    }
    assert len(digests) == 4


def test_bundle_rejects_unsafe_source_nodes_and_destinations(tmp_path: Path) -> None:
    source = _source(tmp_path)
    (source / "link").symlink_to(source / "dataset.toml")
    with pytest.raises(ValueError, match="symbolic links"):
        build_benchmark_bundle(source, tmp_path / "link-bundle")
    (source / "link").unlink()

    (source / ".git").mkdir()
    with pytest.raises(ValueError, match="safe normalized relative path"):
        build_benchmark_bundle(source, tmp_path / "git-bundle")
    (source / ".git").rmdir()

    if hasattr(os, "mkfifo"):
        os.mkfifo(source / "pipe")
        with pytest.raises(ValueError, match="special file"):
            build_benchmark_bundle(source, tmp_path / "pipe-bundle")
        (source / "pipe").unlink()

    invalid_path = os.fsencode(source) + b"/invalid-\xff"
    descriptor = os.open(invalid_path, os.O_CREAT | os.O_WRONLY, 0o600)
    os.close(descriptor)
    with pytest.raises(ValueError, match="not valid UTF-8"):
        build_benchmark_bundle(source, tmp_path / "invalid-name-bundle")
    os.unlink(invalid_path)

    with pytest.raises(ValueError, match="outside its source"):
        build_benchmark_bundle(source, source / "generated")


def test_bundle_rejects_source_mutation_during_construction(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _source(tmp_path)
    original = benchmark_bundle._scan_source
    calls = 0

    def scan(
        root: Path, *, snapshot: Path | None, needles: tuple[bytes, ...]
    ) -> list[BundleEntry]:
        nonlocal calls
        entries = original(root, snapshot=snapshot, needles=needles)
        calls += 1
        if calls == 1:
            (source / "dataset.toml").write_text("changed\n", encoding="utf-8")
        return entries

    monkeypatch.setattr(benchmark_bundle, "_scan_source", scan)

    with pytest.raises(ValueError, match="changed while its bundle was built"):
        build_benchmark_bundle(source, tmp_path / "mutating-bundle")


def test_bundle_rejects_known_credentials_and_private_keys(tmp_path: Path) -> None:
    source = _source(tmp_path)
    secret = "purpose-scoped-secret-123"
    boundary = source / "boundary.bin"
    boundary.write_bytes(b"x" * (1024 * 1024 - 5) + secret.encode())
    with pytest.raises(ValueError, match="credential material"):
        build_benchmark_bundle(
            source,
            tmp_path / "secret-bundle",
            known_secrets=(secret,),
        )

    boundary.write_text(
        "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="credential material"):
        build_benchmark_bundle(source, tmp_path / "key-bundle")


def test_bundle_validation_rejects_changed_or_noncanonical_files(
    tmp_path: Path,
) -> None:
    prepared = build_benchmark_bundle(_source(tmp_path), tmp_path / "bundle")
    prepared.payload_path.write_bytes(prepared.payload_path.read_bytes() + b"changed")
    with pytest.raises(ValueError, match="byte count"):
        validate_benchmark_bundle(prepared.bundle_root)

    prepared = build_benchmark_bundle(
        _source(tmp_path / "again"), tmp_path / "bundle-two"
    )
    manifest = json.loads(prepared.manifest_path.read_text(encoding="utf-8"))
    prepared.manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    with pytest.raises(ValueError, match="canonical JSON"):
        validate_benchmark_bundle(prepared.bundle_root)

    (prepared.bundle_root / "extra").write_text("x", encoding="utf-8")
    with pytest.raises(ValueError, match="exactly its manifest and payload"):
        validate_benchmark_bundle(prepared.bundle_root)


def test_bundle_manifest_requires_sorted_complete_parent_inventory() -> None:
    file_entry = BundleFile(
        path="nested/file.txt",
        mode=420,
        bytes=1,
        sha256="0" * 64,
    )
    with pytest.raises(ValueError, match="missing a parent directory"):
        BenchmarkBundleManifest.model_validate(
            {
                "content_digest": bundle_content_digest([file_entry]),
                "entries": [file_entry.model_dump(mode="json")],
                "payload": {"bytes": 1, "sha256": "1" * 64},
            }
        )

    entries = [
        file_entry,
        BundleDirectory(path="nested"),
    ]
    with pytest.raises(ValueError, match="sorted by UTF-8 path"):
        BenchmarkBundleManifest.model_validate(
            {
                "content_digest": bundle_content_digest(entries),
                "entries": [entry.model_dump(mode="json") for entry in entries],
                "payload": {"bytes": 1, "sha256": "1" * 64},
            }
        )


def test_bundle_extraction_rejects_a_decompression_overrun(tmp_path: Path) -> None:
    root = tmp_path / "bomb"
    root.mkdir()
    payload = zstandard.ZstdCompressor().compress(b"x" * (2 * 1024 * 1024))
    (root / "payload.tar.zst").write_bytes(payload)
    entry = BundleFile(
        path="empty",
        mode=420,
        bytes=0,
        sha256=hashlib.sha256(b"").hexdigest(),
    )
    manifest = BenchmarkBundleManifest(
        content_digest=bundle_content_digest([entry]),
        entries=[entry],
        payload=BundlePayload(
            bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest()
        ),
    )
    (root / "bundle.json").write_bytes(bundle_manifest_bytes(manifest))

    with pytest.raises(ValueError, match="decompressed past its limit"):
        extract_benchmark_bundle(root, tmp_path / "bomb-output")


def test_checked_in_bundle_schema_matches_the_model() -> None:
    path = (
        Path(__file__).parents[1] / "schemas" / "benchmark-bundle-v1alpha1.schema.json"
    )
    assert (
        json.loads(path.read_text(encoding="utf-8")) == benchmark_bundle_json_schema()
    )


def test_bundle_extraction_requires_an_empty_destination(tmp_path: Path) -> None:
    prepared = build_benchmark_bundle(_source(tmp_path), tmp_path / "bundle")
    destination = tmp_path / "destination"
    destination.mkdir()
    (destination / "existing").write_text("x", encoding="utf-8")

    with pytest.raises(ValueError, match="destination must be empty"):
        extract_benchmark_bundle(prepared.bundle_root, destination)
