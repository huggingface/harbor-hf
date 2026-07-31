from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import tarfile
import tempfile
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import IO, Annotated, Literal

import zstandard
from pydantic import BaseModel, ConfigDict, Field, model_validator

from harbor_hf.models import ContentDigest

_BUNDLE_SCHEMA = "harbor-hf/benchmark-bundle/v1alpha1"
_PAYLOAD_NAME = "payload.tar.zst"
_MEDIA_TYPE = "application/vnd.harbor-hf.benchmark-bundle.tar+zstd"
_MAX_ENTRIES = 1_000_000
_MAX_FILE_BYTES = 8 * 1024**3
_MAX_TOTAL_BYTES = 32 * 1024**3
_MAX_PAYLOAD_BYTES = _MAX_TOTAL_BYTES + 1024**3
_MAX_MANIFEST_BYTES = 256 * 1024**2
_PRIVATE_KEY_MARKERS = (
    b"-----BEGIN PRIVATE KEY-----",
    b"-----BEGIN ENCRYPTED PRIVATE KEY-----",
    b"-----BEGIN OPENSSH PRIVATE KEY-----",
    b"-----BEGIN RSA PRIVATE KEY-----",
    b"-----BEGIN EC PRIVATE KEY-----",
    b"-----BEGIN DSA PRIVATE KEY-----",
)


class FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class BundleDirectory(FrozenModel):
    path: str
    type: Literal["directory"] = "directory"
    mode: Literal[493] = 493


class BundleFile(FrozenModel):
    path: str
    type: Literal["file"] = "file"
    mode: Literal[420, 493]
    bytes: int = Field(ge=0, le=_MAX_FILE_BYTES)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


BundleEntry = Annotated[BundleDirectory | BundleFile, Field(discriminator="type")]


class BundlePayload(FrozenModel):
    filename: Literal["payload.tar.zst"] = _PAYLOAD_NAME
    media_type: Literal["application/vnd.harbor-hf.benchmark-bundle.tar+zstd"] = (
        _MEDIA_TYPE
    )
    bytes: int = Field(ge=1, le=_MAX_PAYLOAD_BYTES)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class BenchmarkBundleManifest(FrozenModel):
    schema_version: Literal["harbor-hf/benchmark-bundle/v1alpha1"] = _BUNDLE_SCHEMA
    content_digest: ContentDigest
    entries: list[BundleEntry] = Field(min_length=1, max_length=_MAX_ENTRIES)
    payload: BundlePayload

    @model_validator(mode="after")
    def entries_are_canonical(self) -> BenchmarkBundleManifest:
        paths = [entry.path for entry in self.entries]
        if paths != sorted(paths, key=lambda value: value.encode("utf-8")):
            raise ValueError("benchmark bundle entries must be sorted by UTF-8 path")
        if len(paths) != len(set(paths)):
            raise ValueError("benchmark bundle entry paths must be unique")
        known_directories = {
            PurePosixPath(entry.path)
            for entry in self.entries
            if entry.type == "directory"
        }
        total = 0
        for entry in self.entries:
            path = _validated_relative_path(entry.path)
            if (
                path.parent != PurePosixPath(".")
                and path.parent not in known_directories
            ):
                raise ValueError("benchmark bundle entry is missing a parent directory")
            if isinstance(entry, BundleFile):
                total += entry.bytes
        if total > _MAX_TOTAL_BYTES:
            raise ValueError("benchmark bundle exceeds the total byte limit")
        if self.content_digest != bundle_content_digest(self.entries):
            raise ValueError(
                "benchmark bundle content digest does not match its entries"
            )
        return self


class PreparedBenchmarkBundle(FrozenModel):
    source_root: Path
    bundle_root: Path
    manifest: BenchmarkBundleManifest
    manifest_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")

    model_config = ConfigDict(extra="forbid", frozen=True, arbitrary_types_allowed=True)

    @property
    def manifest_path(self) -> Path:
        return self.bundle_root / "bundle.json"

    @property
    def payload_path(self) -> Path:
        return self.bundle_root / _PAYLOAD_NAME


def benchmark_bundle_json_schema() -> dict[str, object]:
    return BenchmarkBundleManifest.model_json_schema()


def canonical_json_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def bundle_content_digest(entries: list[BundleEntry]) -> str:
    payload = canonical_json_bytes([entry.model_dump(mode="json") for entry in entries])
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def bundle_manifest_bytes(manifest: BenchmarkBundleManifest) -> bytes:
    return canonical_json_bytes(manifest.model_dump(mode="json")) + b"\n"


def build_benchmark_bundle(
    source_root: Path,
    destination: Path,
    *,
    known_secrets: Iterable[str] = (),
) -> PreparedBenchmarkBundle:
    source_root = _validated_source_root(source_root)
    destination = _validated_destination(source_root, destination)
    destination.mkdir(parents=True, exist_ok=True)
    snapshot = destination / "snapshot"
    snapshot.mkdir()
    needles = tuple(value.encode("utf-8") for value in known_secrets if value)
    first = _scan_source(source_root, snapshot=snapshot, needles=needles)
    second = _scan_source(source_root, snapshot=None, needles=needles)
    if first != second:
        raise ValueError("benchmark source changed while its bundle was built")
    payload_path = destination / _PAYLOAD_NAME
    _write_payload(snapshot, first, payload_path)
    manifest = BenchmarkBundleManifest(
        content_digest=bundle_content_digest(first),
        entries=first,
        payload=BundlePayload(
            bytes=payload_path.stat().st_size,
            sha256=_sha256_file(payload_path),
        ),
    )
    manifest_bytes = bundle_manifest_bytes(manifest)
    if len(manifest_bytes) > _MAX_MANIFEST_BYTES:
        raise ValueError("benchmark bundle manifest exceeds its byte limit")
    (destination / "bundle.json").write_bytes(manifest_bytes)
    shutil.rmtree(snapshot)
    prepared = PreparedBenchmarkBundle(
        source_root=source_root,
        bundle_root=destination,
        manifest=manifest,
        manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
    )
    verify_benchmark_bundle(destination)
    return prepared


def validate_benchmark_bundle(root: Path) -> BenchmarkBundleManifest:
    root = _validated_bundle_root(root)
    entries = sorted(path.name for path in root.iterdir())
    if entries != ["bundle.json", _PAYLOAD_NAME]:
        raise ValueError(
            "benchmark bundle must contain exactly its manifest and payload"
        )
    manifest_path = root / "bundle.json"
    if manifest_path.stat().st_size > _MAX_MANIFEST_BYTES:
        raise ValueError("benchmark bundle manifest exceeds its byte limit")
    manifest = BenchmarkBundleManifest.model_validate_json(
        manifest_path.read_text(encoding="utf-8")
    )
    if manifest_path.read_bytes() != bundle_manifest_bytes(manifest):
        raise ValueError("benchmark bundle manifest is not canonical JSON")
    payload = root / manifest.payload.filename
    if payload.stat().st_size != manifest.payload.bytes:
        raise ValueError("benchmark bundle payload byte count does not match")
    if _sha256_file(payload) != manifest.payload.sha256:
        raise ValueError("benchmark bundle payload digest does not match")
    return manifest


def verify_benchmark_bundle(root: Path) -> BenchmarkBundleManifest:
    manifest = validate_benchmark_bundle(root)
    with tempfile.TemporaryDirectory(prefix="harbor-hf-bundle-verification-") as name:
        extract_benchmark_bundle(root, Path(name) / "extracted")
    return manifest


def extract_benchmark_bundle(root: Path, destination: Path) -> Path:
    manifest = validate_benchmark_bundle(root)
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("benchmark extraction destination must be empty")
    destination.mkdir(parents=True, exist_ok=True)
    maximum_raw = (
        sum(entry.bytes for entry in manifest.entries if isinstance(entry, BundleFile))
        + len(manifest.entries) * 2048
        + 1024 * 1024
    )
    with tempfile.NamedTemporaryFile(
        prefix="harbor-hf-benchmark-", suffix=".tar"
    ) as raw:
        _decompress_payload(root / _PAYLOAD_NAME, raw.file, maximum_raw)
        _extract_tar(raw.name, manifest.entries, destination)
    if _scan_source(destination, snapshot=None, needles=()) != manifest.entries:
        raise ValueError("benchmark bundle extracted tree does not match its manifest")
    return destination


def _decompress_payload(source_path: Path, output: IO[bytes], maximum_raw: int) -> None:
    written = 0
    with (
        source_path.open("rb") as source,
        zstandard.ZstdDecompressor().stream_reader(source) as reader,
    ):
        while chunk := reader.read(1024 * 1024):
            written += len(chunk)
            if written > maximum_raw:
                raise ValueError("benchmark bundle decompressed past its limit")
            output.write(chunk)
    output.flush()


def _extract_tar(
    archive_path: str,
    entries: list[BundleEntry],
    destination: Path,
) -> None:
    expected = {entry.path: entry for entry in entries}
    with tarfile.open(archive_path, mode="r:") as archive:
        members = archive.getmembers()
        if [member.name for member in members] != list(expected):
            raise ValueError("benchmark bundle archive inventory does not match")
        for member in members:
            _extract_member(archive, member, expected[member.name], destination)


def _extract_member(
    archive: tarfile.TarFile,
    member: tarfile.TarInfo,
    entry: BundleEntry,
    destination: Path,
) -> None:
    target = _safe_destination(destination, entry.path)
    if (
        member.uid != 0
        or member.gid != 0
        or member.uname != ""
        or member.gname != ""
        or member.mtime != 0
    ):
        raise ValueError("benchmark bundle member metadata is not normalized")
    if isinstance(entry, BundleDirectory):
        if not member.isdir() or member.mode != entry.mode or member.size != 0:
            raise ValueError("benchmark bundle directory member does not match")
        target.mkdir(mode=entry.mode, parents=False, exist_ok=False)
        os.chmod(target, entry.mode)
        return
    if not member.isfile() or member.mode != entry.mode or member.size != entry.bytes:
        raise ValueError("benchmark bundle file member does not match")
    source = archive.extractfile(member)
    if source is None:
        raise ValueError("benchmark bundle file member cannot be read")
    target.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    with target.open("xb") as output:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
            output.write(chunk)
    os.chmod(target, entry.mode)
    if digest.hexdigest() != entry.sha256:
        raise ValueError("benchmark bundle extracted file digest does not match")


def _validated_source_root(root: Path) -> Path:
    try:
        metadata = root.lstat()
    except OSError as error:
        raise ValueError("benchmark directory does not exist") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise ValueError("benchmark directory root must be a real directory")
    return root.resolve(strict=True)


def _validated_destination(source_root: Path, destination: Path) -> Path:
    resolved = destination.resolve(strict=False)
    if resolved == source_root or resolved.is_relative_to(source_root):
        raise ValueError("benchmark bundle destination must be outside its source")
    if destination.exists():
        metadata = destination.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise ValueError("benchmark bundle destination must be a real directory")
        if any(destination.iterdir()):
            raise ValueError("benchmark bundle destination must be empty")
    return destination


def _validated_bundle_root(root: Path) -> Path:
    try:
        metadata = root.lstat()
    except OSError as error:
        raise ValueError("benchmark bundle does not exist") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise ValueError("benchmark bundle root must be a real directory")
    if any(path.is_symlink() or not path.is_file() for path in root.iterdir()):
        raise ValueError("benchmark bundle contains a symlink or non-file entry")
    return root


@dataclass(frozen=True)
class _SourceNode:
    source: Path
    relative: str
    metadata: os.stat_result
    kind: Literal["directory", "file"]


def _scan_source(
    root: Path,
    *,
    snapshot: Path | None,
    needles: tuple[bytes, ...],
) -> list[BundleEntry]:
    entries: list[BundleEntry] = []
    total = 0
    for node in _source_nodes(root):
        if node.kind == "directory":
            entries.append(BundleDirectory(path=node.relative))
            if snapshot is not None:
                (snapshot / node.relative).mkdir(mode=0o755)
            continue
        target = snapshot / node.relative if snapshot is not None else None
        digest, size = _read_regular_file(node.source, target, needles)
        if _stat_identity(node.metadata) != _stat_identity(node.source.lstat()):
            raise ValueError("benchmark file changed while it was read")
        total += size
        if total > _MAX_TOTAL_BYTES:
            raise ValueError("benchmark directory exceeds its total byte limit")
        entries.append(
            BundleFile(
                path=node.relative,
                mode=493 if node.metadata.st_mode & 0o111 else 420,
                bytes=size,
                sha256=digest,
            )
        )
    if not entries:
        raise ValueError("benchmark directory must not be empty")
    return entries


def _source_nodes(root: Path) -> list[_SourceNode]:
    nodes: list[_SourceNode] = []
    pending = [root]
    while pending:
        directory = pending.pop()
        try:
            children = list(directory.iterdir())
        except OSError as error:
            raise ValueError(
                "benchmark directory cannot be traversed safely"
            ) from error
        for child in children:
            node = _source_node(root, child)
            nodes.append(node)
            if node.kind == "directory":
                pending.append(child)
            if len(nodes) > _MAX_ENTRIES:
                raise ValueError("benchmark directory exceeds its entry limit")
    return sorted(nodes, key=lambda node: node.relative.encode("utf-8"))


def _source_node(root: Path, child: Path) -> _SourceNode:
    relative = child.relative_to(root).as_posix()
    _validated_relative_path(relative)
    metadata = child.lstat()
    if stat.S_ISLNK(metadata.st_mode):
        raise ValueError("benchmark directory cannot contain symbolic links")
    if stat.S_ISDIR(metadata.st_mode):
        return _SourceNode(child, relative, metadata, "directory")
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError("benchmark directory contains a special file")
    if metadata.st_size > _MAX_FILE_BYTES:
        raise ValueError("benchmark file exceeds its byte limit")
    return _SourceNode(child, relative, metadata, "file")


def _read_regular_file(
    source: Path,
    destination: Path | None,
    needles: tuple[bytes, ...],
) -> tuple[str, int]:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(source, flags)
    digest = hashlib.sha256()
    size = 0
    patterns = (*_PRIVATE_KEY_MARKERS, *needles)
    overlap = max((len(pattern) for pattern in patterns), default=1) - 1
    tail = b""
    output = None
    if destination is not None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        output = destination.open("xb")
    try:
        while chunk := os.read(descriptor, 1024 * 1024):
            scanned = tail + chunk
            if any(pattern in scanned for pattern in patterns):
                raise ValueError("benchmark directory contains credential material")
            tail = scanned[-overlap:] if overlap else b""
            digest.update(chunk)
            size += len(chunk)
            if output is not None:
                output.write(chunk)
    finally:
        os.close(descriptor)
        if output is not None:
            output.close()
    if destination is not None:
        os.chmod(destination, 0o755 if source.stat().st_mode & 0o111 else 0o644)
    return digest.hexdigest(), size


def _write_payload(
    snapshot: Path, entries: list[BundleEntry], destination: Path
) -> None:
    with tempfile.NamedTemporaryFile(
        prefix="harbor-hf-benchmark-", suffix=".tar"
    ) as raw:
        _write_tar(snapshot, entries, raw.name)
        raw.flush()
        compressor_factory = zstandard.ZstdCompressor(
            level=10,
            threads=0,
            write_checksum=True,
            write_content_size=True,
        )
        with (
            open(raw.name, "rb") as source,
            destination.open("xb") as output,
            compressor_factory.stream_writer(output, closefd=False) as compressor,
        ):
            shutil.copyfileobj(source, compressor, length=1024 * 1024)


def _write_tar(snapshot: Path, entries: list[BundleEntry], destination: str) -> None:
    with tarfile.open(destination, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for entry in entries:
            info = tarfile.TarInfo(entry.path)
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            info.mtime = 0
            info.mode = entry.mode
            if isinstance(entry, BundleDirectory):
                info.type = tarfile.DIRTYPE
                info.size = 0
                archive.addfile(info)
            else:
                info.type = tarfile.REGTYPE
                info.size = entry.bytes
                with (snapshot / entry.path).open("rb") as source:
                    archive.addfile(info, source)


def _validated_relative_path(value: str) -> PurePosixPath:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("benchmark bundle path is not valid UTF-8") from error
    path = PurePosixPath(value)
    if (
        not value
        or path.is_absolute()
        or path.as_posix() != value
        or any(part in {"", ".", "..", ".git"} for part in path.parts)
        or unicodedata.normalize("NFC", value) != value
    ):
        raise ValueError("benchmark bundle path is not a safe normalized relative path")
    return path


def _safe_destination(root: Path, value: str) -> Path:
    path = _validated_relative_path(value)
    candidate = root.joinpath(*path.parts)
    if not candidate.resolve(strict=False).is_relative_to(root.resolve()):
        raise ValueError("benchmark bundle path escapes its destination")
    return candidate


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _stat_identity(value: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_size,
        value.st_mtime_ns,
    )
