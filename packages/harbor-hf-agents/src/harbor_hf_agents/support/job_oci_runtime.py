"""Run one OCI task rootfs as a dedicated unprivileged host user."""

from __future__ import annotations

import asyncio
import ctypes
import errno
import grp
import hashlib
import json
import os
import platform
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Literal, cast

_DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
_DIGEST_IMAGE = re.compile(r"^.+@sha256:[0-9a-f]{64}$")
_MIRROR_REPOSITORY = re.compile(
    r"^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?/"
    r"[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$"
)
_INDEX_MEDIA_TYPES = frozenset(
    {
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.index.v1+json",
    }
)
_OCI_IMAGE_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json"
_OCI_REF_NAME_ANNOTATION = "org.opencontainers.image.ref.name"
_GZIP_LAYER_MEDIA_TYPES = frozenset(
    {
        "application/vnd.docker.image.rootfs.diff.tar.gzip",
        "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip",
        "application/vnd.oci.image.layer.v1.tar+gzip",
        "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip",
    }
)
_TAR_LAYER_MEDIA_TYPES = frozenset(
    {
        "application/vnd.oci.image.layer.v1.tar",
        "application/vnd.oci.image.layer.nondistributable.v1.tar",
    }
)
_ZSTD_LAYER_MEDIA_TYPES = frozenset(
    {
        "application/vnd.oci.image.layer.v1.tar+zstd",
        "application/vnd.oci.image.layer.nondistributable.v1.tar+zstd",
    }
)
_FORBIDDEN_ENVIRONMENT_NAMES = frozenset(
    {
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "HF_INFERENCE_TOKEN",
        "HF_TOKEN",
        "SSH_AUTH_SOCK",
    }
)
_MAX_COMMAND_OUTPUT_BYTES = 1_000_000
_OUTPUT_TRUNCATION_NOTICE = b"\n[harbor-hf: output truncated]\n"
_TASK_UID = 60_000
_TASK_GID = 60_000
_CAP_SYS_PTRACE = 19
_PROCESS_CLEANUP_SECONDS = 10.0
_IMAGE_COPY_OVERHEAD_BYTES = 16 * 1024 * 1024
_IMAGE_COPY_POLL_SECONDS = 0.1
_MINIMUM_PROOT_VERSION = (5, 3, 0)
_PROOT_VERSION = re.compile(rb"\bv([0-9]+)\.([0-9]+)\.([0-9]+)\b")
_PREFLIGHT_ENVIRONMENT = {
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "PATH": _DEFAULT_PATH,
}
_PROOT_ENVIRONMENT = {
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "PATH": _DEFAULT_PATH,
}


class OciRuntimeError(RuntimeError):
    """Base error for the task OCI runtime."""


class OciRuntimeUnavailableError(OciRuntimeError):
    """Raised when the physical Job cannot provide the required isolation."""


class OciImageIntegrityError(OciRuntimeError):
    """Raised when registry content does not match the locked task image."""


class OciTransferError(OciRuntimeError):
    """Raised when a task transfer violates its durable limits."""


@dataclass(frozen=True)
class TransferLimits:
    """Hard limits applied to every task filesystem transfer."""

    max_total_bytes: int
    max_file_bytes: int
    max_files: int
    max_path_depth: int

    def __post_init__(self) -> None:
        for name, value in (
            ("max_total_bytes", self.max_total_bytes),
            ("max_file_bytes", self.max_file_bytes),
            ("max_files", self.max_files),
            ("max_path_depth", self.max_path_depth),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{name} must be a positive integer")
        if self.max_file_bytes > self.max_total_bytes:
            raise ValueError("max_file_bytes cannot exceed max_total_bytes")


@dataclass(frozen=True)
class ImageLimits:
    """Hard limits applied before the unpacked image tree is mutated."""

    max_bytes: int
    max_entries: int

    def __post_init__(self) -> None:
        for name, value in (
            ("max_bytes", self.max_bytes),
            ("max_entries", self.max_entries),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{name} must be a positive integer")


@dataclass(frozen=True)
class _ContainerUser:
    uid: int
    gid: int
    home: str
    name: str


@dataclass(frozen=True)
class _TransferEntry:
    source: Path
    relative: PurePosixPath
    mode: int
    size: int
    directory: bool


@dataclass(frozen=True)
class _BlobDescriptor:
    digest: str
    size: int


@dataclass(frozen=True)
class _LayerDescriptor(_BlobDescriptor):
    compression: Literal["gzip", "tar", "zstd"]


@dataclass(frozen=True)
class _ImageManifest:
    config: _BlobDescriptor
    layers: tuple[_LayerDescriptor, ...]

    @property
    def compressed_bytes(self) -> int:
        """Return the exact descriptor bytes copied into the OCI layout."""
        return self.config.size + sum(layer.size for layer in self.layers)


@dataclass
class _ImageArchiveStats:
    regular_bytes: int
    entries: int


def _optional(mapping: dict[str, object], key: str) -> object | None:
    try:
        return mapping[key]
    except KeyError:
        return None


def _clean_tool_environment(workspace: Path) -> dict[str, str]:
    home = workspace / "home"
    runtime = workspace / "run"
    home.mkdir(mode=0o700)
    runtime.mkdir(mode=0o700)
    return {
        "HOME": str(home),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": _DEFAULT_PATH,
        "REGISTRY_AUTH_FILE": str(workspace / "auth.json"),
        "XDG_RUNTIME_DIR": str(runtime),
    }


def _run_checked(
    arguments: list[str],
    *,
    environment: dict[str, str],
    label: str,
) -> subprocess.CompletedProcess[bytes]:
    try:
        result = subprocess.run(
            arguments,
            check=False,
            capture_output=True,
            env=environment,
        )
    except OSError as error:
        raise OciRuntimeUnavailableError(f"failed to start {label}: {error}") from error
    if result.returncode != 0:
        detail = result.stderr.decode(errors="replace").strip()
        raise OciRuntimeUnavailableError(
            f"{label} failed with code {result.returncode}: {detail}"
        )
    return result


def _directory_regular_bytes(path: Path) -> int:
    total = 0
    for root, _directories, files in os.walk(path):
        for name in files:
            try:
                metadata = (Path(root) / name).stat()
            except FileNotFoundError:
                continue
            if stat.S_ISREG(metadata.st_mode):
                total += metadata.st_size
    return total


@dataclass
class _BoundedProcessOutput:
    chunks: list[bytes]
    retained_bytes: int = 0
    truncated: bool = False
    error: BaseException | None = None


def _drain_bounded_process_output(
    stream: BinaryIO,
    output: _BoundedProcessOutput,
) -> None:
    try:
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                return
            remaining = max(0, _MAX_COMMAND_OUTPUT_BYTES - output.retained_bytes)
            if remaining:
                retained = chunk[:remaining]
                output.chunks.append(retained)
                output.retained_bytes += len(retained)
            if len(chunk) > remaining:
                output.truncated = True
    except (OSError, ValueError) as error:
        output.error = error


def _bounded_process_output(output: _BoundedProcessOutput) -> bytes:
    value = b"".join(output.chunks)
    if output.truncated:
        value += _OUTPUT_TRUNCATION_NOTICE
    return value


def _start_bounded_output_readers(
    process: subprocess.Popen[bytes],
    label: str,
) -> tuple[
    _BoundedProcessOutput,
    _BoundedProcessOutput,
    tuple[threading.Thread, threading.Thread],
]:
    if process.stdout is None or process.stderr is None:
        raise OciRuntimeUnavailableError(f"{label} output pipes are unavailable")
    stdout_output = _BoundedProcessOutput([])
    stderr_output = _BoundedProcessOutput([])
    readers = (
        threading.Thread(
            target=_drain_bounded_process_output,
            args=(process.stdout, stdout_output),
            daemon=True,
        ),
        threading.Thread(
            target=_drain_bounded_process_output,
            args=(process.stderr, stderr_output),
            daemon=True,
        ),
    )
    for reader in readers:
        reader.start()
    return stdout_output, stderr_output, readers


def _join_bounded_output_readers(
    process: subprocess.Popen[bytes],
    readers: tuple[threading.Thread, threading.Thread],
    label: str,
) -> None:
    drain_deadline = time.monotonic() + _PROCESS_CLEANUP_SECONDS
    for reader in readers:
        reader.join(timeout=max(0.0, drain_deadline - time.monotonic()))
    if any(reader.is_alive() for reader in readers):
        if process.stdout is not None:
            with suppress(OSError):
                os.close(process.stdout.fileno())
        if process.stderr is not None:
            with suppress(OSError):
                os.close(process.stderr.fileno())
        close_deadline = time.monotonic() + _PROCESS_CLEANUP_SECONDS
        for reader in readers:
            if reader.is_alive():
                reader.join(timeout=max(0.0, close_deadline - time.monotonic()))
    if any(reader.is_alive() for reader in readers):
        raise OciRuntimeUnavailableError(
            f"{label} output readers did not stop after process-group cleanup"
        )


def _finish_bounded_process(
    process: subprocess.Popen[bytes],
    stdout_output: _BoundedProcessOutput,
    stderr_output: _BoundedProcessOutput,
    readers: tuple[threading.Thread, threading.Thread],
    label: str,
) -> tuple[bytes, bytes]:
    wait_error: subprocess.TimeoutExpired | None = None
    with suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)
    try:
        process.wait(timeout=_PROCESS_CLEANUP_SECONDS)
    except subprocess.TimeoutExpired as error:
        wait_error = error
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
    _join_bounded_output_readers(process, readers, label)
    if wait_error is not None:
        raise OciRuntimeUnavailableError(
            f"{label} process group survived cleanup"
        ) from wait_error
    error = stdout_output.error or stderr_output.error
    if error is not None:
        raise OciRuntimeUnavailableError(f"{label} output reader failed") from error
    return (
        _bounded_process_output(stdout_output),
        _bounded_process_output(stderr_output),
    )


def _run_checked_with_directory_limit(
    arguments: list[str],
    *,
    environment: dict[str, str],
    label: str,
    directory: Path,
    max_bytes: int,
) -> subprocess.CompletedProcess[bytes]:
    """Run one copy while bounding bytes written before manifest validation."""
    try:
        process = subprocess.Popen(
            arguments,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            start_new_session=True,
        )
    except OSError as error:
        raise OciRuntimeUnavailableError(f"failed to start {label}: {error}") from error
    stdout_output, stderr_output, readers = _start_bounded_output_readers(
        process, label
    )
    exceeded = False
    try:
        while process.poll() is None:
            if stdout_output.error is not None or stderr_output.error is not None:
                break
            if _directory_regular_bytes(directory) > max_bytes:
                exceeded = True
                break
            time.sleep(_IMAGE_COPY_POLL_SECONDS)
    finally:
        stdout, stderr = _finish_bounded_process(
            process,
            stdout_output,
            stderr_output,
            readers,
            label,
        )
    if exceeded or _directory_regular_bytes(directory) > max_bytes:
        raise OciImageIntegrityError(
            "task image copy exceeded the bounded compressed byte allowance"
        )
    if process.returncode != 0:
        detail = stderr.decode(errors="replace").strip()
        raise OciRuntimeUnavailableError(
            f"{label} failed with code {process.returncode}: {detail}"
        )
    return subprocess.CompletedProcess(arguments, process.returncode, stdout, stderr)


def _run_preflight_command(
    arguments: list[str],
    label: str,
) -> subprocess.CompletedProcess[bytes]:
    try:
        result = subprocess.run(
            arguments,
            check=False,
            capture_output=True,
            env=_PREFLIGHT_ENVIRONMENT,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise OciRuntimeUnavailableError(
            f"{label} preflight failed: {error}"
        ) from error
    if result.returncode != 0:
        detail = result.stderr.decode(errors="replace").strip()
        raise OciRuntimeUnavailableError(f"{label} preflight failed: {detail}")
    return result


def _require_supported_proot() -> None:
    result = _run_preflight_command(["proot", "--version"], "proot")
    match = _PROOT_VERSION.search(result.stdout + result.stderr)
    if match is None:
        raise OciRuntimeUnavailableError("proot preflight returned an unknown version")
    version = tuple(int(part) for part in match.groups())
    if version < _MINIMUM_PROOT_VERSION:
        required = ".".join(str(part) for part in _MINIMUM_PROOT_VERSION)
        current = ".".join(str(part) for part in version)
        raise OciRuntimeUnavailableError(
            f"proot {required} or newer is required; found {current}"
        )


def _setpriv_arguments(arguments: list[str]) -> list[str]:
    """Launch a command with the complete dedicated task identity policy."""
    return [
        "setpriv",
        "--reuid",
        str(_TASK_UID),
        "--regid",
        str(_TASK_GID),
        "--clear-groups",
        "--no-new-privs",
        "--bounding-set=-all",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--",
        *arguments,
    ]


def _mirrored_reference(image: str, mirror_repository: str) -> str:
    """Return the configured mirror repository at the locked source digest."""
    if _MIRROR_REPOSITORY.fullmatch(mirror_repository) is None:
        raise OciImageIntegrityError("task image mirror repository is invalid")
    digest = image.rsplit("@", 1)[1]
    return f"docker://{mirror_repository}@{digest}"


def _skopeo_source_copy_arguments(
    auth_file: Path,
    source: str,
    source_directory: Path,
) -> list[str]:
    """Copy the locked remote image once without changing its manifest."""
    return [
        "skopeo",
        "copy",
        "--authfile",
        str(auth_file),
        source,
        f"dir:{source_directory}",
    ]


def _skopeo_oci_copy_arguments(
    auth_file: Path,
    source_directory: Path,
    image_layout: Path,
) -> list[str]:
    """Convert a validated local source image to an OCI image layout."""
    return [
        "skopeo",
        "copy",
        "--authfile",
        str(auth_file),
        "--format",
        "oci",
        f"dir:{source_directory}",
        f"oci:{image_layout}:task",
    ]


def _platform_architecture() -> str:
    machine = platform.machine().lower()
    architectures = {
        "aarch64": "arm64",
        "amd64": "amd64",
        "arm64": "arm64",
        "x86_64": "amd64",
    }
    try:
        return architectures[machine]
    except KeyError as error:
        raise OciRuntimeUnavailableError(
            f"unsupported physical Job architecture: {machine}"
        ) from error


def _manifest_object(raw_manifest: bytes, label: str) -> dict[str, object]:
    try:
        value = json.loads(raw_manifest)
    except json.JSONDecodeError as error:
        raise OciImageIntegrityError(f"{label} is not valid JSON") from error
    if not isinstance(value, dict):
        raise OciImageIntegrityError(f"{label} must be an object")
    return cast(dict[str, object], value)


def _selected_manifest(  # noqa: C901 -- explicit OCI index validation
    image: str,
    raw_manifest: bytes,
    mirror_repository: str,
) -> tuple[str, str]:
    """Verify the locked digest and select one native Linux manifest."""
    expected_digest = image.rsplit("@", 1)[1]
    actual_digest = f"sha256:{hashlib.sha256(raw_manifest).hexdigest()}"
    if actual_digest != expected_digest:
        raise OciImageIntegrityError(
            "registry manifest does not match the prepared task image digest"
        )
    typed_value = _manifest_object(raw_manifest, "task image manifest")
    media_type = _optional(typed_value, "mediaType")
    if media_type not in _INDEX_MEDIA_TYPES:
        return _mirrored_reference(image, mirror_repository), expected_digest
    manifests = _optional(typed_value, "manifests")
    if not isinstance(manifests, list):
        raise OciImageIntegrityError("task image index has no manifest list")
    architecture = _platform_architecture()
    matches: list[str] = []
    for descriptor in manifests:
        if not isinstance(descriptor, dict):
            continue
        typed_descriptor = cast(dict[str, object], descriptor)
        target = _optional(typed_descriptor, "platform")
        digest = _optional(typed_descriptor, "digest")
        if not isinstance(target, dict):
            continue
        typed_target = cast(dict[str, object], target)
        target_os = _optional(typed_target, "os")
        target_architecture = _optional(typed_target, "architecture")
        if (
            target_os == "linux"
            and target_architecture == architecture
            and isinstance(digest, str)
            and re.fullmatch(r"sha256:[0-9a-f]{64}", digest)
        ):
            matches.append(digest)
    if len(matches) != 1:
        raise OciImageIntegrityError(
            "task image index must contain exactly one manifest for "
            f"linux/{architecture}"
        )
    source = _mirrored_reference(image, mirror_repository).rsplit("@", 1)[0]
    return f"{source}@{matches[0]}", matches[0]


def _blob_descriptor(value: object, label: str) -> _BlobDescriptor:
    if not isinstance(value, dict):
        raise OciImageIntegrityError(f"task image {label} descriptor is invalid")
    descriptor = cast(dict[str, object], value)
    try:
        digest = descriptor["digest"]
        size = descriptor["size"]
    except KeyError as error:
        raise OciImageIntegrityError(
            f"task image {label} descriptor is incomplete"
        ) from error
    if (
        not isinstance(digest, str)
        or re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is None
        or isinstance(size, bool)
        or not isinstance(size, int)
        or size < 1
    ):
        raise OciImageIntegrityError(f"task image {label} descriptor is invalid")
    return _BlobDescriptor(digest=digest, size=size)


def _layer_compression(media_type: object) -> Literal["gzip", "tar", "zstd"]:
    if media_type in _GZIP_LAYER_MEDIA_TYPES:
        return "gzip"
    if media_type in _TAR_LAYER_MEDIA_TYPES:
        return "tar"
    if media_type in _ZSTD_LAYER_MEDIA_TYPES:
        return "zstd"
    raise OciImageIntegrityError("task image layer compression is unsupported")


def _layer_descriptors(
    values: object,
    config_size: int,
    limits: ImageLimits,
) -> tuple[_LayerDescriptor, ...]:
    if not isinstance(values, list):
        raise OciImageIntegrityError("task image layers must be a list")
    if len(values) > limits.max_entries:
        raise OciImageIntegrityError("task image has too many layer descriptors")
    layers: list[_LayerDescriptor] = []
    compressed_bytes = config_size
    for index, value in enumerate(values):
        blob = _blob_descriptor(value, f"layer {index}")
        layer = cast(dict[str, object], value)
        try:
            media_type = layer["mediaType"]
        except KeyError as error:
            raise OciImageIntegrityError(
                f"task image layer {index} has no media type"
            ) from error
        compressed_bytes += blob.size
        if compressed_bytes > limits.max_bytes:
            raise OciImageIntegrityError(
                "task image compressed blobs exceed the aggregate byte limit"
            )
        layers.append(
            _LayerDescriptor(
                digest=blob.digest,
                size=blob.size,
                compression=_layer_compression(media_type),
            )
        )
    return tuple(layers)


def _image_manifest(
    raw_manifest: bytes,
    expected_digest: str,
    limits: ImageLimits,
) -> _ImageManifest:
    """Validate one selected image manifest before downloading its blobs."""
    actual_digest = f"sha256:{hashlib.sha256(raw_manifest).hexdigest()}"
    if actual_digest != expected_digest:
        raise OciImageIntegrityError("selected task image manifest digest changed")
    manifest = _manifest_object(raw_manifest, "selected task image manifest")
    try:
        config_value = manifest["config"]
        layer_values = manifest["layers"]
    except KeyError as error:
        raise OciImageIntegrityError(
            "selected task image manifest is incomplete"
        ) from error
    config = _blob_descriptor(config_value, "config")
    if config.size > limits.max_bytes:
        raise OciImageIntegrityError(
            "task image compressed blobs exceed the aggregate byte limit"
        )
    return _ImageManifest(
        config=config,
        layers=_layer_descriptors(layer_values, config.size, limits),
    )


def _copied_source_image(
    source_directory: Path,
    task_image: str,
    mirror_repository: str,
    auth_file: Path,
    environment: dict[str, str],
    limits: ImageLimits,
) -> tuple[_ImageManifest, dict[str, object]]:
    """Validate the exact manifest and config produced by one remote copy."""
    raw_manifest = _run_checked(
        ["skopeo", "inspect", "--raw", f"dir:{source_directory}"],
        environment=environment,
        label="local task image manifest inspection",
    ).stdout
    selected_digest = f"sha256:{hashlib.sha256(raw_manifest).hexdigest()}"
    locked_digest = task_image.rsplit("@", 1)[1]
    if selected_digest != locked_digest:
        raw_index = _run_checked(
            [
                "skopeo",
                "inspect",
                "--authfile",
                str(auth_file),
                "--raw",
                _mirrored_reference(task_image, mirror_repository),
            ],
            environment=environment,
            label="task image index inspection",
        ).stdout
        _source, expected_selected_digest = _selected_manifest(
            task_image,
            raw_index,
            mirror_repository,
        )
        if selected_digest != expected_selected_digest:
            raise OciImageIntegrityError(
                "copied task image manifest does not match the locked image"
            )
    manifest = _image_manifest(raw_manifest, selected_digest, limits)
    config = _manifest_object(
        _run_checked(
            ["skopeo", "inspect", "--config", f"dir:{source_directory}"],
            environment=environment,
            label="local task image config inspection",
        ).stdout,
        "selected task image config",
    )
    return manifest, config


def _blob_path(image_layout: Path, digest: str) -> Path:
    return image_layout / "blobs" / "sha256" / digest.removeprefix("sha256:")


def _file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _validate_blob(image_layout: Path, descriptor: _BlobDescriptor) -> Path:
    blob = _blob_path(image_layout, descriptor.digest)
    try:
        metadata = blob.stat()
    except OSError as error:
        raise OciImageIntegrityError("copied task image blob is missing") from error
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_size != descriptor.size
        or _file_digest(blob) != descriptor.digest
    ):
        raise OciImageIntegrityError("copied task image blob failed validation")
    return blob


def _is_named_task_manifest(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    descriptor = cast(dict[str, object], value)
    annotations = _optional(descriptor, "annotations")
    return (
        isinstance(annotations, dict)
        and _optional(
            cast(dict[str, object], annotations),
            _OCI_REF_NAME_ANNOTATION,
        )
        == "task"
    )


def _read_image_bytes(path: Path, message: str) -> bytes:
    try:
        return path.read_bytes()
    except OSError as error:
        raise OciImageIntegrityError(message) from error


def _validate_copied_oci_manifest(
    image_layout: Path,
    expected: _ImageManifest,
    expected_config: dict[str, object],
    limits: ImageLimits,
) -> _ImageManifest:
    """Verify Skopeo's OCI conversion retains locked layers and config meaning."""
    raw_index = _read_image_bytes(
        image_layout / "index.json",
        "copied task image index is missing",
    )
    index = _manifest_object(raw_index, "copied task image index")
    if _optional(index, "schemaVersion") != 2:
        raise OciImageIntegrityError("copied task image index has an invalid schema")
    values = _optional(index, "manifests")
    if not isinstance(values, list):
        raise OciImageIntegrityError("copied task image index has no manifests")
    matches = [
        cast(dict[str, object], value)
        for value in values
        if _is_named_task_manifest(value)
    ]
    if len(matches) != 1:
        raise OciImageIntegrityError(
            "copied task image must contain exactly one named manifest"
        )
    descriptor_value = matches[0]
    if _optional(descriptor_value, "mediaType") != _OCI_IMAGE_MANIFEST_MEDIA_TYPE:
        raise OciImageIntegrityError(
            "copied task image reference is not an OCI image manifest"
        )
    descriptor = _blob_descriptor(descriptor_value, "copied manifest")
    manifest_blob = _validate_blob(image_layout, descriptor)
    raw_manifest = _read_image_bytes(
        manifest_blob,
        "copied task image manifest cannot be read",
    )
    copied = _image_manifest(raw_manifest, descriptor.digest, limits)
    if copied.layers != expected.layers:
        raise OciImageIntegrityError("copied task image manifest layers changed")
    config_blob = _validate_blob(image_layout, copied.config)
    raw_config = _read_image_bytes(
        config_blob,
        "copied task image config cannot be read",
    )
    copied_config = _manifest_object(raw_config, "copied task image config")
    if copied_config != expected_config:
        raise OciImageIntegrityError("copied task image config changed")
    return copied


def _scan_tar_stream(
    stream: BinaryIO,
    mode: Literal["r|", "r|gz"],
    limits: ImageLimits,
    stats: _ImageArchiveStats,
) -> None:
    try:
        with tarfile.open(fileobj=stream, mode=mode) as archive:
            for member in archive:
                stats.entries += 1
                if stats.entries > limits.max_entries:
                    raise OciImageIntegrityError(
                        "task image layers exceed the entry count limit"
                    )
                if not member.isreg():
                    continue
                if member.size < 0:
                    raise OciImageIntegrityError(
                        "task image layer contains a negative file size"
                    )
                stats.regular_bytes += member.size
                if stats.regular_bytes > limits.max_bytes:
                    raise OciImageIntegrityError(
                        "task image layers exceed the expanded byte limit"
                    )
    except OciImageIntegrityError:
        raise
    except (OSError, tarfile.TarError) as error:
        raise OciImageIntegrityError("task image layer archive is invalid") from error


def _scan_layer(
    blob: Path,
    compression: Literal["gzip", "tar", "zstd"],
    limits: ImageLimits,
    stats: _ImageArchiveStats,
) -> None:
    if compression != "zstd":
        with blob.open("rb") as stream:
            _scan_tar_stream(
                stream,
                "r|gz" if compression == "gzip" else "r|",
                limits,
                stats,
            )
        return
    try:
        process = subprocess.Popen(
            ["zstd", "--decompress", "--stdout", "--", str(blob)],
            env=_PREFLIGHT_ENVIRONMENT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as error:
        raise OciRuntimeUnavailableError(
            f"failed to start task image zstd inspection: {error}"
        ) from error
    if process.stdout is None:
        process.kill()
        process.wait()
        raise OciRuntimeUnavailableError("task image zstd output pipe is missing")
    try:
        _scan_tar_stream(cast(BinaryIO, process.stdout), "r|", limits, stats)
    except BaseException:
        process.kill()
        process.communicate()
        raise
    _, stderr = process.communicate()
    if process.returncode != 0:
        detail = stderr.decode(errors="replace").strip()
        raise OciImageIntegrityError(f"task image zstd layer is invalid: {detail}")


def _inspect_image_layout(
    image_layout: Path,
    manifest: _ImageManifest,
    limits: ImageLimits,
) -> _ImageArchiveStats:
    """Validate every compressed blob and bound expansion before umoci runs."""
    _validate_blob(image_layout, manifest.config)
    stats = _ImageArchiveStats(regular_bytes=0, entries=0)
    for layer in manifest.layers:
        blob = _validate_blob(image_layout, layer)
        _scan_layer(blob, layer.compression, limits, stats)
    return stats


def _require_free_space(path: Path, required_bytes: int, label: str) -> None:
    if shutil.disk_usage(path).free < required_bytes:
        raise OciRuntimeUnavailableError(
            f"insufficient Job-local disk space for task image {label}"
        )


def _filesystem_block_size(path: Path) -> int:
    try:
        block_size = os.statvfs(path).f_frsize
    except OSError as error:
        raise OciRuntimeUnavailableError(
            "cannot inspect Job-local filesystem block size"
        ) from error
    if block_size < 1:
        raise OciRuntimeUnavailableError("Job-local filesystem block size is invalid")
    return block_size


def _extraction_metadata_bytes(path: Path, entries: int) -> int:
    # One block covers per-path filesystem slack and one covers umoci's mtree
    # metadata. The same amount is held back so cleanup can still make progress.
    return max(entries, 1) * _filesystem_block_size(path) * 2


@contextmanager
def _reserved_extraction_space(
    workspace: Path,
    stats: _ImageArchiveStats,
) -> Iterator[None]:
    metadata_bytes = _extraction_metadata_bytes(workspace, stats.entries)
    _require_free_space(
        workspace,
        stats.regular_bytes + (2 * metadata_bytes),
        "extraction",
    )
    reservation = workspace / "extraction-space.reserve"
    descriptor = os.open(
        reservation,
        os.O_CREAT | os.O_EXCL | os.O_RDWR,
        0o600,
    )
    try:
        fallocate = getattr(os, "posix_fallocate", None)
        if not callable(fallocate):
            raise OciRuntimeUnavailableError(
                "cannot reserve Job-local disk space for task image extraction"
            )
        try:
            fallocate(descriptor, 0, metadata_bytes)
        except OSError as error:
            raise OciRuntimeUnavailableError(
                "cannot reserve Job-local disk space for task image extraction"
            ) from error
        _require_free_space(
            workspace,
            stats.regular_bytes + metadata_bytes,
            "extraction after reservation",
        )
        yield
    finally:
        os.close(descriptor)
        reservation.unlink(missing_ok=True)


def _validate_environment(environment: dict[str, str]) -> None:
    for name, value in environment.items():
        if name in _FORBIDDEN_ENVIRONMENT_NAMES or name.startswith("HARBOR_HF_"):
            raise OciImageIntegrityError(
                f"task image environment declares forbidden authority name {name}"
            )
        if "\0" in name or "\0" in value or "=" in name:
            raise OciImageIntegrityError("task image environment is malformed")


def _environment_map(values: object) -> dict[str, str]:
    if not isinstance(values, list):
        raise OciImageIntegrityError("task image process environment must be a list")
    output: dict[str, str] = {}
    for item in values:
        if not isinstance(item, str) or "=" not in item:
            raise OciImageIntegrityError("task image process environment is malformed")
        name, value = item.split("=", 1)
        output[name] = value
    _validate_environment(output)
    return output


def _load_image_config(bundle: Path) -> tuple[dict[str, str], _ContainerUser, str]:
    try:
        value = json.loads((bundle / "config.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise OciImageIntegrityError(
            "unpacked task image has no valid OCI config"
        ) from error
    if not isinstance(value, dict):
        raise OciImageIntegrityError("unpacked task OCI config is incomplete")
    process_value = _optional(cast(dict[str, object], value), "process")
    if not isinstance(process_value, dict):
        raise OciImageIntegrityError("unpacked task OCI config is incomplete")
    process = cast(dict[str, object], process_value)
    environment = _environment_map(_optional(process, "env"))
    cwd = _optional(process, "cwd")
    user = _optional(process, "user")
    if not isinstance(cwd, str) or not cwd.startswith("/") or ".." in Path(cwd).parts:
        raise OciImageIntegrityError("task image working directory is invalid")
    if not isinstance(user, dict):
        raise OciImageIntegrityError("task image process user is invalid")
    typed_user = cast(dict[str, object], user)
    uid = _optional(typed_user, "uid")
    gid = _optional(typed_user, "gid")
    if (
        isinstance(uid, bool)
        or not isinstance(uid, int)
        or uid < 0
        or isinstance(gid, bool)
        or not isinstance(gid, int)
        or gid < 0
    ):
        raise OciImageIntegrityError("task image process user is invalid")
    return (
        environment,
        _ContainerUser(uid=uid, gid=gid, home="/", name=str(uid)),
        cwd,
    )


def _validate_task_path(
    value: str,
    *,
    label: str,
    max_depth: int,
) -> PurePosixPath:
    path = PurePosixPath(value)
    if not path.is_absolute() or ".." in path.parts:
        raise OciTransferError(f"{label} must be an absolute task path")
    if len(path.parts) - 1 > max_depth:
        raise OciTransferError(f"{label} exceeds the path depth limit")
    return path


def _checked_host_path(path: Path, *, label: str) -> Path:
    absolute = path if path.is_absolute() else Path.cwd() / path
    if ".." in absolute.parts:
        raise OciTransferError(f"{label} contains parent traversal")
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode):
            raise OciTransferError(f"{label} traverses a symbolic link: {current}")
    return absolute


def _scan_transfer_tree(  # noqa: C901 -- bounded no-follow traversal
    source: Path,
    limits: TransferLimits,
    *,
    contents_only: bool,
    base_depth: int,
) -> list[_TransferEntry]:
    source = _checked_host_path(source, label="transfer source")
    metadata = source.lstat()
    if not stat.S_ISREG(metadata.st_mode) and not stat.S_ISDIR(metadata.st_mode):
        raise OciTransferError("transfer source is not a regular file or directory")
    roots = (
        sorted(source.iterdir(), key=lambda item: item.name)
        if contents_only
        else [source]
    )
    pending = [(item, PurePosixPath(item.name)) for item in reversed(roots)]
    entries: list[_TransferEntry] = []
    total_bytes = 0
    while pending:
        path, relative = pending.pop()
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise OciTransferError(f"transfer contains a symbolic link: {path}")
        if base_depth + len(relative.parts) > limits.max_path_depth:
            raise OciTransferError("transfer exceeds the path depth limit")
        if len(entries) >= limits.max_files:
            raise OciTransferError("transfer exceeds the entry count limit")
        if stat.S_ISDIR(metadata.st_mode):
            entries.append(
                _TransferEntry(
                    source=path,
                    relative=relative,
                    mode=stat.S_IMODE(metadata.st_mode),
                    size=0,
                    directory=True,
                )
            )
            children = sorted(path.iterdir(), key=lambda item: item.name)
            pending.extend(
                (child, relative / child.name) for child in reversed(children)
            )
            continue
        if not stat.S_ISREG(metadata.st_mode):
            raise OciTransferError(f"transfer contains an unsupported file: {path}")
        if metadata.st_size > limits.max_file_bytes:
            raise OciTransferError(f"transfer file exceeds the size limit: {path}")
        total_bytes += metadata.st_size
        if total_bytes > limits.max_total_bytes:
            raise OciTransferError("transfer exceeds the aggregate size limit")
        entries.append(
            _TransferEntry(
                source=path,
                relative=relative,
                mode=stat.S_IMODE(metadata.st_mode),
                size=metadata.st_size,
                directory=False,
            )
        )
    return entries


def _ensure_directory(path: Path, owner: tuple[int, int] | None) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        path.mkdir(mode=0o700)
        if owner is not None:
            os.chown(path, owner[0], owner[1])
        return
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise OciTransferError(f"transfer destination is not a directory: {path}")


def _ensure_destination_parents(
    root: Path,
    destination: Path,
    owner: tuple[int, int] | None,
) -> None:
    try:
        relative = destination.relative_to(root)
    except ValueError as error:
        raise OciTransferError("transfer destination escapes its root") from error
    current = root
    _ensure_directory(current, owner)
    for part in relative.parts[:-1]:
        current /= part
        _ensure_directory(current, owner)


def _copy_regular_file(  # noqa: C901 -- atomic bounded copy cleanup
    source: Path,
    destination: Path,
    *,
    expected_size: int,
    mode: int,
    limits: TransferLimits,
    total_written: list[int],
    owner: tuple[int, int] | None,
) -> None:
    transfer_root = Path(destination.anchor) if destination.anchor else Path("/")
    _ensure_destination_parents(transfer_root, destination, owner)
    try:
        existing = destination.lstat()
    except FileNotFoundError:
        existing = None
    if existing is not None and (
        stat.S_ISLNK(existing.st_mode) or not stat.S_ISREG(existing.st_mode)
    ):
        raise OciTransferError(
            f"transfer destination is not a regular file: {destination}"
        )
    source_descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    temporary_descriptor = -1
    temporary_path: Path | None = None
    try:
        source_metadata = os.fstat(source_descriptor)
        if (
            not stat.S_ISREG(source_metadata.st_mode)
            or source_metadata.st_size != expected_size
        ):
            raise OciTransferError("transfer source changed during copy")
        temporary_descriptor, raw_path = tempfile.mkstemp(
            prefix=".harbor-hf-copy-",
            dir=destination.parent,
        )
        temporary_path = Path(raw_path)
        written = 0
        with (
            os.fdopen(source_descriptor, "rb", closefd=False) as input_file,
            os.fdopen(temporary_descriptor, "wb", closefd=False) as output_file,
        ):
            while chunk := input_file.read(64 * 1024):
                written += len(chunk)
                total_written[0] += len(chunk)
                if (
                    written > limits.max_file_bytes
                    or total_written[0] > limits.max_total_bytes
                ):
                    raise OciTransferError(
                        "transfer exceeded its byte limits during copy"
                    )
                output_file.write(chunk)
        if written != expected_size or os.fstat(source_descriptor).st_size != written:
            raise OciTransferError("transfer source changed during copy")
        os.fchmod(temporary_descriptor, mode & 0o777)
        if owner is not None:
            os.fchown(temporary_descriptor, owner[0], owner[1])
        os.close(temporary_descriptor)
        temporary_descriptor = -1
        os.replace(temporary_path, destination)
        temporary_path = None
    finally:
        os.close(source_descriptor)
        if temporary_descriptor >= 0:
            os.close(temporary_descriptor)
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def _copy_entries(
    entries: list[_TransferEntry],
    destination: Path,
    limits: TransferLimits,
    *,
    contents_only: bool,
    owner: tuple[int, int] | None,
) -> None:
    destination = _checked_host_path(destination, label="transfer destination")
    if contents_only:
        _ensure_directory(destination, owner)
    total_written = [0]
    entries_copied = 0
    directories: list[tuple[Path, int]] = []
    for entry in entries:
        entries_copied += 1
        if entries_copied > limits.max_files:
            raise OciTransferError("transfer exceeds the entry count limit during copy")
        target = destination / entry.relative if contents_only else destination
        if entry.directory:
            transfer_root = (
                Path(target.parent.anchor) if target.parent.anchor else Path("/")
            )
            _ensure_destination_parents(transfer_root, target, owner)
            _ensure_directory(target, owner)
            directories.append((target, entry.mode))
            continue
        _copy_regular_file(
            entry.source,
            target,
            expected_size=entry.size,
            mode=entry.mode,
            limits=limits,
            total_written=total_written,
            owner=owner,
        )
    for path, mode in reversed(directories):
        path.chmod(mode & 0o777)


def _status_values(pid: int) -> dict[str, str]:
    try:
        lines = Path(f"/proc/{pid}/status").read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return {}
    output: dict[str, str] = {}
    for line in lines:
        name, separator, value = line.partition(":")
        if separator:
            output[name] = value.strip()
    return output


def _effective_capabilities(pid: int) -> int:
    status = _status_values(pid)
    try:
        return int(status["CapEff"], 16)
    except (KeyError, ValueError) as error:
        raise OciRuntimeUnavailableError(
            f"cannot inspect effective capabilities for process {pid}"
        ) from error


def _task_process_ids() -> set[int]:
    processes: set[int] = set()
    try:
        entries = list(Path("/proc").iterdir())
    except OSError as error:
        raise OciRuntimeUnavailableError(
            "cannot enumerate physical Job processes"
        ) from error
    for entry in entries:
        if not entry.name.isdigit():
            continue
        status = _status_values(int(entry.name))
        if not status:
            continue
        try:
            real_uid = int(status["Uid"].split()[0])
        except (KeyError, IndexError, ValueError) as error:
            raise OciRuntimeUnavailableError(
                f"cannot inspect process identity: {entry.name}"
            ) from error
        if real_uid == _TASK_UID:
            processes.add(int(entry.name))
    return processes


def _task_process_state(pid: int) -> str | None:
    state = _status_values(pid)
    if not state:
        return None
    try:
        return state["State"].split(maxsplit=1)[0]
    except (KeyError, IndexError) as error:
        raise OciRuntimeUnavailableError(
            f"cannot inspect process state: {pid}"
        ) from error


def _task_process_is_dead(pid: int) -> bool:
    return _task_process_state(pid) in {"Z", "X", "x"}


def _task_process_is_quiescent(pid: int) -> bool:
    # Zombies and dead processes cannot execute or mutate the task filesystem.
    return _task_process_state(pid) in {"T", "t", "Z", "X", "x"}


def _stop_task_processes_until_stable() -> set[int]:
    deadline = time.monotonic() + _PROCESS_CLEANUP_SECONDS
    stable_passes = 0
    previous: set[int] | None = None
    while time.monotonic() < deadline:
        current = _task_process_ids()
        for pid in current:
            try:
                os.kill(pid, signal.SIGSTOP)
            except ProcessLookupError:
                continue
        observed = _task_process_ids()
        all_quiescent = all(_task_process_is_quiescent(pid) for pid in observed)
        if all_quiescent and observed == previous:
            stable_passes += 1
            if stable_passes >= 2:
                final = _task_process_ids()
                if final == observed and all(
                    _task_process_is_quiescent(pid) for pid in final
                ):
                    return final
        else:
            stable_passes = 0
        previous = observed
        time.sleep(0.01)
    raise OciRuntimeUnavailableError(
        "task process set did not stabilize during cleanup"
    )


def _kill_task_processes() -> None:
    stopped = _stop_task_processes_until_stable()
    for pid in stopped:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            continue
    deadline = time.monotonic() + _PROCESS_CLEANUP_SECONDS
    while time.monotonic() < deadline:
        remaining = {
            pid for pid in _task_process_ids() if not _task_process_is_dead(pid)
        }
        if not remaining:
            return
        for pid in remaining:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                continue
            with suppress(ChildProcessError):
                os.waitpid(pid, os.WNOHANG)
        time.sleep(0.01)
    raise OciRuntimeUnavailableError("task processes survived SIGKILL cleanup")


@contextmanager
def _paused_task_processes() -> Iterator[None]:
    stopped = _stop_task_processes_until_stable()
    try:
        if stopped != _task_process_ids() or not all(
            _task_process_is_quiescent(pid) for pid in stopped
        ):
            raise OciRuntimeUnavailableError(
                "task process set changed after the verified UID freeze"
            )
        yield
    finally:
        current = _task_process_ids()
        for pid in stopped & current:
            try:
                os.kill(pid, signal.SIGCONT)
            except ProcessLookupError:
                continue


def _validate_unused_task_identity() -> None:
    try:
        pwd.getpwuid(_TASK_UID)
    except KeyError:
        pass
    else:
        raise OciRuntimeUnavailableError(
            f"dedicated task UID {_TASK_UID} is present in the worker account database"
        )
    try:
        grp.getgrgid(_TASK_GID)
    except KeyError:
        pass
    else:
        raise OciRuntimeUnavailableError(
            f"dedicated task GID {_TASK_GID} is present in the worker group database"
        )
    if _task_process_ids():
        raise OciRuntimeUnavailableError(
            f"dedicated task UID {_TASK_UID} is already in use"
        )


def _run_security_probe() -> None:
    descriptor, raw_path = tempfile.mkstemp(prefix="harbor-hf-root-probe-")
    probe_path = Path(raw_path)
    try:
        os.write(descriptor, b"root-only\n")
        os.fchmod(descriptor, 0o600)
    finally:
        os.close(descriptor)
    script = (
        "import os, pathlib, sys\n"
        "uid = int(sys.argv[1]); gid = int(sys.argv[2])\n"
        "if os.getresuid() != (uid, uid, uid):\n"
        "    raise SystemExit('real/effective/saved task UIDs were not applied')\n"
        "if os.getresgid() != (gid, gid, gid):\n"
        "    raise SystemExit('real/effective/saved task GIDs were not applied')\n"
        "if os.getgroups():\n"
        "    raise SystemExit('task identity was not applied')\n"
        "status = {}\n"
        "for line in pathlib.Path('/proc/self/status').read_text().splitlines():\n"
        "    name, separator, value = line.partition(':')\n"
        "    if separator:\n"
        "        status[name] = value.strip()\n"
        "if [int(value) for value in status['Uid'].split()] != [uid] * 4:\n"
        "    raise SystemExit('real/effective/saved/fs task UIDs were not applied')\n"
        "if [int(value) for value in status['Gid'].split()] != [gid] * 4:\n"
        "    raise SystemExit('real/effective/saved/fs task GIDs were not applied')\n"
        "for name in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'):\n"
        "    if int(status[name], 16) != 0:\n"
        "        raise SystemExit(f'{name} was not cleared')\n"
        "if status['NoNewPrivs'] != '1':\n"
        "    raise SystemExit('no_new_privs was not set')\n"
        "for path in sys.argv[3:]:\n"
        "    try:\n"
        "        pathlib.Path(path).read_bytes()\n"
        "    except PermissionError:\n"
        "        continue\n"
        "    raise SystemExit(f'task UID could read root path: {path}')\n"
    )
    try:
        result = subprocess.run(
            _setpriv_arguments(
                [
                    sys.executable,
                    "-c",
                    script,
                    str(_TASK_UID),
                    str(_TASK_GID),
                    f"/proc/{os.getpid()}/environ",
                    str(probe_path),
                ]
            ),
            check=False,
            capture_output=True,
            env=_PREFLIGHT_ENVIRONMENT,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise OciRuntimeUnavailableError(
            f"dedicated task UID security probe failed: {error}"
        ) from error
    finally:
        probe_path.unlink(missing_ok=True)
    if result.returncode != 0:
        detail = result.stderr.decode(errors="replace").strip()
        raise OciRuntimeUnavailableError(
            f"dedicated task UID security probe failed: {detail}"
        )


def _remove_file_capability(path: Path) -> None:
    if platform.system() != "Linux":
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if (
        libc.lremovexattr(
            os.fsencode(path),
            b"security.capability",
        )
        != 0
    ):
        error_number = ctypes.get_errno()
        if error_number not in {
            errno.ENODATA,
            errno.ENOTSUP,
            getattr(errno, "ENOATTR", errno.ENODATA),
        }:
            raise OSError(error_number, os.strerror(error_number), path)


def _rootfs_metadata(path: Path) -> os.stat_result:
    try:
        return path.lstat()
    except OSError as error:
        raise OciImageIntegrityError(
            "cannot inspect the unpacked task image rootfs"
        ) from error


def _rootfs_children(path: Path) -> list[Path]:
    try:
        return sorted(path.iterdir(), key=lambda item: item.name)
    except OSError as error:
        raise OciImageIntegrityError(
            "cannot enumerate the unpacked task image rootfs"
        ) from error


def _validate_rootfs_limits(rootfs: Path, limits: ImageLimits) -> None:
    """Reject an oversized unpacked tree before ownership or modes change."""
    pending = [rootfs]
    entries = 0
    regular_bytes = 0
    while pending:
        path = pending.pop()
        metadata = _rootfs_metadata(path)
        entries += path != rootfs
        if entries > limits.max_entries:
            raise OciImageIntegrityError(
                "task image rootfs exceeds the entry count limit"
            )
        if stat.S_ISDIR(metadata.st_mode):
            pending.extend(reversed(_rootfs_children(path)))
        elif stat.S_ISREG(metadata.st_mode):
            regular_bytes += metadata.st_size
            if regular_bytes > limits.max_bytes:
                raise OciImageIntegrityError(
                    "task image rootfs exceeds the aggregate byte limit"
                )


def _sanitize_rootfs(rootfs: Path, uid: int, gid: int) -> None:
    """Make the rootfs task-owned while removing kernel privilege artifacts."""
    pending = [rootfs]
    while pending:
        path = pending.pop()
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            os.chown(path, uid, gid, follow_symlinks=False)
            continue
        if stat.S_ISDIR(metadata.st_mode):
            children = sorted(path.iterdir(), key=lambda item: item.name)
            pending.extend(reversed(children))
            os.chown(path, uid, gid)
            path.chmod((stat.S_IMODE(metadata.st_mode) & 0o1777) | 0o700)
            _remove_file_capability(path)
            continue
        if stat.S_ISREG(metadata.st_mode):
            os.chown(path, uid, gid)
            path.chmod((stat.S_IMODE(metadata.st_mode) & 0o1777) | 0o600)
            _remove_file_capability(path)
            continue
        raise OciImageIntegrityError(
            f"task image rootfs contains a special file: {path.relative_to(rootfs)}"
        )


def _resolved_rootfs_path(  # noqa: C901 -- confined symlink resolution
    rootfs: Path,
    value: str,
) -> Path:
    pending = list(PurePosixPath(value).parts[1:])
    resolved: list[str] = []
    symlinks = 0
    while pending:
        part = pending.pop(0)
        if part in ("", "."):
            continue
        if part == "..":
            if not resolved:
                raise OciImageIntegrityError(
                    f"task image path escapes its rootfs: {value}"
                )
            resolved.pop()
            continue
        candidate = rootfs.joinpath(*resolved, part)
        try:
            metadata = candidate.lstat()
        except OSError as error:
            raise OciImageIntegrityError(f"task image requires {value}") from error
        if not stat.S_ISLNK(metadata.st_mode):
            resolved.append(part)
            continue
        symlinks += 1
        if symlinks > 40:
            raise OciImageIntegrityError(f"task image path has a symlink loop: {value}")
        target = PurePosixPath(os.readlink(candidate))
        target_parts = list(target.parts[1:] if target.is_absolute() else target.parts)
        if target.is_absolute():
            resolved.clear()
        pending = target_parts + pending
    return rootfs.joinpath(*resolved)


def _prepare_guest_runtime_paths(  # noqa: C901 -- explicit guest path checks
    rootfs: Path,
) -> None:
    for relative, mode in (
        ("dev", 0o755),
        ("dev/pts", 0o755),
        ("proc", 0o755),
        ("run", 0o755),
        ("tmp", 0o1777),
    ):
        path = rootfs / relative
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            path.mkdir(mode=mode)
            os.chown(path, _TASK_UID, _TASK_GID)
        else:
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
                raise OciImageIntegrityError(
                    f"task image /{relative} is not a directory"
                )
        path.chmod(mode)
    ptmx = rootfs / "dev/ptmx"
    try:
        metadata = ptmx.lstat()
    except FileNotFoundError:
        ptmx.symlink_to("pts/ptmx")
    else:
        if stat.S_ISREG(metadata.st_mode):
            ptmx.unlink()
            ptmx.symlink_to("pts/ptmx")
        elif not stat.S_ISLNK(metadata.st_mode) or os.readlink(ptmx) not in {
            "pts/ptmx",
            "/dev/pts/ptmx",
        }:
            raise OciImageIntegrityError(
                "task image /dev/ptmx cannot receive the devpts binding"
            )
    for relative in ("dev/null", "dev/zero", "dev/random", "dev/urandom"):
        path = rootfs / relative
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            path.touch(mode=0o600)
            os.chown(path, _TASK_UID, _TASK_GID)
            continue
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise OciImageIntegrityError(
                f"task image /{relative} cannot receive the safe device binding"
            )
    for relative in ("/bin/bash", "/usr/bin/env"):
        path = _resolved_rootfs_path(rootfs, relative)
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o111 == 0:
            raise OciImageIntegrityError(f"task image {relative} is not executable")


async def _read_bounded_stream(
    stream: asyncio.StreamReader,
    limit: int,
) -> bytes:
    output = bytearray()
    truncated = False
    while chunk := await stream.read(64 * 1024):
        remaining = limit - len(output)
        if remaining > 0:
            output.extend(chunk[:remaining])
        if len(chunk) > max(remaining, 0):
            truncated = True
    if truncated:
        output.extend(_OUTPUT_TRUNCATION_NOTICE)
    return bytes(output)


class IsolatedOciRuntime:
    """Fetch, unpack, execute, and remove one task-owned OCI rootfs."""

    def __init__(
        self,
        task_image: str,
        transfer_limits: TransferLimits,
        image_limits: ImageLimits,
        *,
        control_task_image_mirror_repository: str,
    ) -> None:
        if _DIGEST_IMAGE.fullmatch(task_image) is None:
            raise OciImageIntegrityError("task image is not digest-pinned")
        self.task_image = task_image
        self.task_image_mirror_repository = control_task_image_mirror_repository
        _mirrored_reference(task_image, control_task_image_mirror_repository)
        self.transfer_limits = transfer_limits
        self.image_limits = image_limits
        self.workspace = Path(tempfile.mkdtemp(prefix="harbor-hf-task-runtime-"))
        self.workspace.chmod(0o700)
        self.bundle = self.workspace / "bundle"
        self.rootfs = Path(tempfile.mkdtemp(prefix="harbor-hf-task-rootfs-"))
        self.rootfs.chmod(0o700)
        self._environment = _clean_tool_environment(self.workspace)
        self._image_environment: dict[str, str] = {}
        self._image_user = _ContainerUser(uid=0, gid=0, home="/root", name="root")
        self._image_cwd = "/"
        self._running = False
        self._background_processes: set[asyncio.subprocess.Process] = set()

    @staticmethod
    def preflight() -> None:
        """Fail unless the Job can enforce the real-UID task boundary."""
        if platform.system() != "Linux":
            raise OciRuntimeUnavailableError("task OCI execution requires Linux")
        if os.geteuid() != 0:
            raise OciRuntimeUnavailableError(
                "task OCI execution requires the trusted worker to run as root"
            )
        for command in ("proot", "setpriv", "skopeo", "umoci", "zstd", "git"):
            if shutil.which(command) is None:
                raise OciRuntimeUnavailableError(
                    f"trusted worker image does not contain required tool {command}"
                )
        _validate_unused_task_identity()
        if _effective_capabilities(os.getpid()) & (1 << _CAP_SYS_PTRACE):
            raise OciRuntimeUnavailableError(
                "trusted worker must not have effective CAP_SYS_PTRACE"
            )
        _require_supported_proot()
        for arguments, label in (
            (["setpriv", "--version"], "setpriv"),
            (["skopeo", "--version"], "skopeo"),
            (["umoci", "--version"], "umoci"),
            (["zstd", "--version"], "zstd"),
            (["git", "--version"], "git"),
        ):
            _run_preflight_command(arguments, label)
        _run_security_probe()

    async def start(self) -> None:
        """Fetch, verify, unpack, and map the task rootfs."""
        if self._running:
            raise OciRuntimeError("task OCI runtime is already running")
        try:
            await asyncio.to_thread(self._prepare_rootfs)
            self._running = True
        except BaseException:
            await self.stop()
            raise

    def _prepare_rootfs(self) -> None:
        auth_file = self.workspace / "auth.json"
        auth_file.write_text('{"auths":{}}\n', encoding="utf-8")
        auth_file.chmod(0o600)
        # One remote copy avoids consuming separate registry pulls for manifest,
        # config, and blob requests. The source manifest and config are then
        # inspected locally before conversion to the OCI layout used by umoci.
        _require_free_space(
            self.workspace,
            self.image_limits.max_bytes * 2,
            "copy",
        )
        source_directory = self.workspace / "source"
        source_directory.mkdir(mode=0o700)
        _run_checked_with_directory_limit(
            _skopeo_source_copy_arguments(
                auth_file,
                _mirrored_reference(
                    self.task_image,
                    self.task_image_mirror_repository,
                ),
                source_directory,
            ),
            environment=self._environment,
            label="task image copy",
            directory=source_directory,
            max_bytes=self.image_limits.max_bytes + _IMAGE_COPY_OVERHEAD_BYTES,
        )
        manifest, source_config = _copied_source_image(
            source_directory,
            self.task_image,
            self.task_image_mirror_repository,
            auth_file,
            self._environment,
            self.image_limits,
        )
        image_layout = self.workspace / "image"
        _run_checked(
            _skopeo_oci_copy_arguments(
                auth_file,
                source_directory,
                image_layout,
            ),
            environment=self._environment,
            label="local task image OCI conversion",
        )
        copied_manifest = _validate_copied_oci_manifest(
            image_layout,
            manifest,
            source_config,
            self.image_limits,
        )
        shutil.rmtree(source_directory)
        archive_stats = _inspect_image_layout(
            image_layout,
            copied_manifest,
            self.image_limits,
        )
        with _reserved_extraction_space(self.workspace, archive_stats):
            _run_checked(
                [
                    "umoci",
                    "unpack",
                    "--image",
                    f"{image_layout}:task",
                    str(self.bundle),
                ],
                environment=self._environment,
                label="task image unpack",
            )
        (
            self._image_environment,
            self._image_user,
            self._image_cwd,
        ) = _load_image_config(self.bundle)
        unpacked_rootfs = self.bundle / "rootfs"
        if not unpacked_rootfs.is_dir():
            raise OciImageIntegrityError("unpacked task image rootfs is missing")
        _validate_rootfs_limits(unpacked_rootfs, self.image_limits)
        _sanitize_rootfs(unpacked_rootfs, _TASK_UID, _TASK_GID)
        _prepare_guest_runtime_paths(unpacked_rootfs)
        self.rootfs.rmdir()
        unpacked_rootfs.rename(self.rootfs)

    async def _reap_background_processes(self) -> None:
        processes = tuple(self._background_processes)
        for process in processes:
            if process.returncode is None:
                with suppress(ProcessLookupError):
                    process.kill()
        if processes:
            await asyncio.gather(
                *(process.wait() for process in processes),
                return_exceptions=True,
            )
        self._background_processes.clear()

    async def stop(self) -> None:
        """Stop every process with the dedicated UID, then remove task files."""
        if platform.system() == "Linux":
            if os.geteuid() != 0:
                raise OciRuntimeUnavailableError(
                    "trusted worker lost root before task cleanup"
                )
            await asyncio.to_thread(_kill_task_processes)
        await self._reap_background_processes()
        self._running = False
        shutil.rmtree(self.rootfs, ignore_errors=True)
        shutil.rmtree(self.workspace, ignore_errors=True)

    async def quiesce(self) -> None:
        """Kill every task-UID process while retaining the prepared rootfs."""
        if not self._running:
            return
        if platform.system() != "Linux" or os.geteuid() != 0:
            raise OciRuntimeUnavailableError(
                "trusted worker cannot quiesce the dedicated task UID"
            )
        await asyncio.to_thread(_kill_task_processes)
        await self._reap_background_processes()

    def _resolve_user(  # noqa: C901 -- strict passwd parsing
        self,
        user: str | int | None,
    ) -> _ContainerUser:
        if user is None:
            user = self._image_user.uid
        if isinstance(user, bool):
            raise OciTransferError("task execution user is invalid")
        if isinstance(user, int) or user.isdigit():
            uid = int(user)
            requested_name: str | None = None
        else:
            uid = -1
            requested_name = user
        passwd = self.rootfs / "etc" / "passwd"
        try:
            lines = passwd.read_text(encoding="utf-8").splitlines()
        except OSError as error:
            raise OciTransferError("task image has no readable /etc/passwd") from error
        for line in lines:
            fields = line.split(":")
            if len(fields) != 7:
                continue
            try:
                entry_uid = int(fields[2])
                entry_gid = int(fields[3])
            except ValueError:
                continue
            if (requested_name is not None and fields[0] == requested_name) or (
                requested_name is None and entry_uid == uid
            ):
                return _ContainerUser(
                    uid=entry_uid,
                    gid=entry_gid,
                    home=fields[5] or "/",
                    name=fields[0],
                )
        raise OciTransferError(f"task execution user does not exist: {user}")

    def _proot_arguments(
        self,
        command: str,
        *,
        cwd: str | None,
        environment: dict[str, str],
        user: str | int | None,
    ) -> list[str]:
        account = self._resolve_user(user)
        merged = dict(self._image_environment)
        merged.update(environment)
        _validate_environment(merged)
        merged["HOME"] = account.home
        merged["LOGNAME"] = account.name
        merged["USER"] = account.name
        working_directory = cwd if cwd is not None else self._image_cwd
        _validate_task_path(
            working_directory,
            label="task working directory",
            max_depth=self.transfer_limits.max_path_depth,
        )
        # OCI images often link resolv.conf into /run, which is empty here.
        # PRoot dereferences this guest bind path and exposes the Job's resolver.
        arguments = [
            "proot",
            "-r",
            str(self.rootfs),
            "-w",
            working_directory,
            "-i",
            f"{account.uid}:{account.gid}",
            "-b",
            "/etc/resolv.conf:/etc/resolv.conf",
            "-b",
            "/proc:/proc",
            # Interactive agent runtimes such as OpenHands need a devpts mount
            # to create their own pseudoterminals inside the isolated Job.
            "-b",
            "/dev/pts:/dev/pts",
        ]
        for device in (
            "/dev/null",
            "/dev/zero",
            "/dev/random",
            "/dev/urandom",
            "/dev/ptmx",
        ):
            arguments.extend(["-b", f"{device}:{device}"])
        arguments.extend(["/usr/bin/env", "-i"])
        arguments.extend(f"{name}={value}" for name, value in sorted(merged.items()))
        arguments.extend(["/bin/bash", "-lc", command])
        return arguments

    async def start_background(
        self,
        command: str,
        *,
        cwd: str | None,
        environment: dict[str, str],
        user: str | int | None,
    ) -> None:
        """Start one lifecycle-owned command without a per-command timeout."""
        if not self._running:
            raise OciRuntimeError("task OCI runtime is not running")
        arguments = self._proot_arguments(
            command,
            cwd=cwd,
            environment=environment,
            user=user,
        )
        process = await asyncio.create_subprocess_exec(
            *_setpriv_arguments(arguments),
            env=_PROOT_ENVIRONMENT,
            start_new_session=True,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._background_processes.add(process)
        await asyncio.sleep(0)
        if process.returncode is not None:
            await process.wait()
            self._background_processes.discard(process)
            if process.returncode != 0:
                raise OciRuntimeError("background task command failed to start")

    async def exec(
        self,
        command: str,
        *,
        cwd: str | None,
        environment: dict[str, str],
        timeout_seconds: int,
        user: str | int | None,
    ) -> tuple[str, str, int]:
        """Execute one command with a fake image identity and a real task UID."""
        if not self._running:
            raise OciRuntimeError("task OCI runtime is not running")
        arguments = self._proot_arguments(
            command,
            cwd=cwd,
            environment=environment,
            user=user,
        )
        process = await asyncio.create_subprocess_exec(
            *_setpriv_arguments(arguments),
            env=_PROOT_ENVIRONMENT,
            start_new_session=True,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        if process.stdout is None or process.stderr is None:
            raise OciRuntimeError("task command output pipe is missing")
        stdout_task = asyncio.create_task(
            _read_bounded_stream(process.stdout, _MAX_COMMAND_OUTPUT_BYTES)
        )
        stderr_task = asyncio.create_task(
            _read_bounded_stream(process.stderr, _MAX_COMMAND_OUTPUT_BYTES)
        )
        try:
            async with asyncio.timeout(timeout_seconds):
                await process.wait()
                stdout, stderr = await asyncio.gather(stdout_task, stderr_task)
        except (TimeoutError, asyncio.CancelledError):
            if process.returncode is None:
                process.kill()
            await process.wait()
            await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
            await self.stop()
            raise
        if process.returncode is None:
            raise OciRuntimeError("task command did not terminate")
        return (
            stdout.decode(errors="replace"),
            stderr.decode(errors="replace"),
            process.returncode,
        )

    def _task_host_path(self, path: PurePosixPath, *, label: str) -> Path:
        target = self.rootfs.joinpath(*path.parts[1:])
        current = self.rootfs
        for part in path.parts[1:]:
            current /= part
            try:
                metadata = current.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(metadata.st_mode):
                raise OciTransferError(f"{label} traverses a symbolic link")
        return target

    async def upload_file(
        self,
        source: Path,
        target: str,
        *,
        timeout_seconds: int,
    ) -> None:
        """Copy one bounded regular host file into the stopped task tree."""
        del timeout_seconds
        task_target = _validate_task_path(
            target,
            label="upload destination",
            max_depth=self.transfer_limits.max_path_depth,
        )
        if not task_target.name:
            raise OciTransferError("upload file destination must name a file")
        await asyncio.to_thread(
            self._upload_while_paused,
            source,
            task_target,
            False,
        )

    async def upload_dir(
        self,
        source: Path,
        target: str,
        *,
        timeout_seconds: int,
    ) -> None:
        """Copy bounded directory contents into the stopped task tree."""
        del timeout_seconds
        task_target = _validate_task_path(
            target,
            label="upload destination",
            max_depth=self.transfer_limits.max_path_depth,
        )
        await asyncio.to_thread(
            self._upload_while_paused,
            source,
            task_target,
            True,
        )

    async def download_file(
        self,
        source: str,
        target: Path,
        *,
        timeout_seconds: int,
    ) -> None:
        """Copy one bounded regular task file to a trusted host path."""
        del timeout_seconds
        task_source = _validate_task_path(
            source,
            label="download source",
            max_depth=self.transfer_limits.max_path_depth,
        )
        await asyncio.to_thread(
            self._download_while_paused,
            task_source,
            target,
            False,
        )

    async def download_dir(
        self,
        source: str,
        target: Path,
        *,
        timeout_seconds: int,
    ) -> None:
        """Copy bounded task directory contents to a trusted host path."""
        del timeout_seconds
        task_source = _validate_task_path(
            source,
            label="download source",
            max_depth=self.transfer_limits.max_path_depth,
        )
        await asyncio.to_thread(
            self._download_while_paused,
            task_source,
            target,
            True,
        )

    def _upload_while_paused(
        self,
        source: Path,
        task_target: PurePosixPath,
        contents_only: bool,
    ) -> None:
        with _paused_task_processes():
            if contents_only:
                source_metadata = source.lstat()
                if not stat.S_ISDIR(source_metadata.st_mode):
                    raise OciTransferError("upload directory source is not a directory")
            entries = _scan_transfer_tree(
                source,
                self.transfer_limits,
                contents_only=contents_only,
                base_depth=len(task_target.parts) - 1 if contents_only else 0,
            )
            if not contents_only and (len(entries) != 1 or entries[0].directory):
                raise OciTransferError("upload file source must be one regular file")
            destination = self._task_host_path(
                task_target,
                label="upload destination",
            )
            _copy_entries(
                entries,
                destination,
                self.transfer_limits,
                contents_only=contents_only,
                owner=(_TASK_UID, _TASK_GID),
            )

    def _download_while_paused(
        self,
        task_source: PurePosixPath,
        target: Path,
        contents_only: bool,
    ) -> None:
        with _paused_task_processes():
            source = self._task_host_path(task_source, label="download source")
            if contents_only:
                metadata = source.lstat()
                if not stat.S_ISDIR(metadata.st_mode):
                    raise OciTransferError(
                        "download directory source is not a directory"
                    )
            entries = _scan_transfer_tree(
                source,
                self.transfer_limits,
                contents_only=contents_only,
                base_depth=(
                    len(task_source.parts) - 1
                    if contents_only
                    else len(task_source.parts) - 2
                ),
            )
            if not contents_only and (len(entries) != 1 or entries[0].directory):
                raise OciTransferError("download file source must be one regular file")
            _copy_entries(
                entries,
                target,
                self.transfer_limits,
                contents_only=contents_only,
                owner=None,
            )
