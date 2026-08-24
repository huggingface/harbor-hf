from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import platform
import pwd
import shutil
import stat
import subprocess
import sys
import tarfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

import pytest

from harbor_hf_agents.support import job_oci_runtime as runtime
from harbor_hf_agents.support.job_oci_runtime import (
    ImageLimits,
    IsolatedOciRuntime,
    OciImageIntegrityError,
    OciRuntimeUnavailableError,
    OciTransferError,
    TransferLimits,
)

_TASK_IMAGE = (
    "example.invalid/task@sha256:"
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)


def _limits() -> TransferLimits:
    return TransferLimits(
        max_total_bytes=16,
        max_file_bytes=8,
        max_files=4,
        max_path_depth=3,
    )


def _image_limits() -> ImageLimits:
    return ImageLimits(max_bytes=1024, max_entries=32)


def _compressed_layer(files: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, contents in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(contents)
            archive.addfile(member, io.BytesIO(contents))
    return output.getvalue()


def _image_layout(
    tmp_path: Path,
    layer: bytes,
    limits: ImageLimits,
) -> tuple[Path, runtime._ImageManifest]:
    image_layout = tmp_path / "image"
    blobs = image_layout / "blobs" / "sha256"
    blobs.mkdir(parents=True)
    config = b"{}"
    config_digest = f"sha256:{hashlib.sha256(config).hexdigest()}"
    layer_digest = f"sha256:{hashlib.sha256(layer).hexdigest()}"
    (blobs / config_digest.removeprefix("sha256:")).write_bytes(config)
    (blobs / layer_digest.removeprefix("sha256:")).write_bytes(layer)
    raw_manifest = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": config_digest,
                "size": len(config),
            },
            "layers": [
                {
                    "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                    "digest": layer_digest,
                    "size": len(layer),
                }
            ],
        },
        separators=(",", ":"),
    ).encode()
    manifest_digest = f"sha256:{hashlib.sha256(raw_manifest).hexdigest()}"
    return image_layout, runtime._image_manifest(
        raw_manifest,
        manifest_digest,
        limits,
    )


def _cleanup_runtime(isolated: IsolatedOciRuntime) -> None:
    shutil.rmtree(isolated.rootfs, ignore_errors=True)
    shutil.rmtree(isolated.workspace, ignore_errors=True)


def _linux_task_uid_available() -> bool:
    if sys.platform != "linux" or os.geteuid() != 0:
        return False
    try:
        pwd.getpwuid(runtime._TASK_UID)
    except KeyError:
        pass
    else:
        return False
    try:
        return not runtime._task_process_ids()
    except OciRuntimeUnavailableError:
        return False


def test_manifest_digest_mismatch_fails_closed() -> None:
    with pytest.raises(OciImageIntegrityError, match="does not match"):
        runtime._selected_manifest(_TASK_IMAGE, b'{"schemaVersion":2}')


def test_docker_reference_removes_tag_before_digest() -> None:
    digest = f"sha256:{'a' * 64}"

    assert (
        runtime._docker_reference(f"registry.example:5000/team/task:locked@{digest}")
        == f"docker://registry.example:5000/team/task@{digest}"
    )
    assert (
        runtime._docker_reference(f"debian:forky-slim@{digest}")
        == f"docker://docker.io/library/debian@{digest}"
    )


def test_multiarch_manifest_selects_only_native_linux_image(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    selected_digest = f"sha256:{'b' * 64}"
    value = {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [
            {
                "digest": f"sha256:{'c' * 64}",
                "platform": {"os": "linux", "architecture": "arm64"},
            },
            {
                "digest": selected_digest,
                "platform": {"os": "linux", "architecture": "amd64"},
            },
        ],
    }
    raw = json.dumps(value, separators=(",", ":")).encode()
    image = f"example.invalid/task@sha256:{hashlib.sha256(raw).hexdigest()}"
    monkeypatch.setattr(platform, "machine", lambda: "x86_64")

    source, digest = runtime._selected_manifest(image, raw)

    assert source == f"docker://example.invalid/task@{selected_digest}"
    assert digest == selected_digest


def test_manifest_rejects_compressed_layer_bytes_before_copy() -> None:
    raw_manifest = json.dumps(
        {
            "schemaVersion": 2,
            "config": {
                "digest": f"sha256:{'b' * 64}",
                "size": 2,
            },
            "layers": [
                {
                    "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                    "digest": f"sha256:{'c' * 64}",
                    "size": 1025,
                }
            ],
        },
        separators=(",", ":"),
    ).encode()
    digest = f"sha256:{hashlib.sha256(raw_manifest).hexdigest()}"

    with pytest.raises(OciImageIntegrityError, match="compressed blobs"):
        runtime._image_manifest(raw_manifest, digest, _image_limits())


def test_manifest_rejects_config_blob_bytes_before_copy() -> None:
    raw_manifest = json.dumps(
        {
            "schemaVersion": 2,
            "config": {"digest": f"sha256:{'b' * 64}", "size": 1025},
            "layers": [],
        },
        separators=(",", ":"),
    ).encode()
    digest = f"sha256:{hashlib.sha256(raw_manifest).hexdigest()}"

    with pytest.raises(OciImageIntegrityError, match="compressed blobs"):
        runtime._image_manifest(raw_manifest, digest, _image_limits())


def test_layer_scan_rejects_expansion_before_extraction(tmp_path: Path) -> None:
    layer = _compressed_layer({"large": b"x" * 2048})
    image_layout, manifest = _image_layout(tmp_path, layer, _image_limits())

    with pytest.raises(OciImageIntegrityError, match="expanded byte"):
        runtime._inspect_image_layout(image_layout, manifest, _image_limits())


def test_layer_scan_enforces_aggregate_entry_limit(tmp_path: Path) -> None:
    limits = ImageLimits(max_bytes=1024, max_entries=1)
    layer = _compressed_layer({"first": b"", "second": b""})
    image_layout, manifest = _image_layout(tmp_path, layer, limits)

    with pytest.raises(OciImageIntegrityError, match="entry count"):
        runtime._inspect_image_layout(image_layout, manifest, limits)


def test_extraction_reserves_metadata_space_until_completion(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    checks: list[tuple[int, str]] = []
    allocations: list[int] = []
    monkeypatch.setattr(runtime, "_filesystem_block_size", lambda _path: 4096)
    monkeypatch.setattr(
        runtime,
        "_require_free_space",
        lambda _path, required, label: checks.append((required, label)),
    )
    monkeypatch.setattr(
        os,
        "posix_fallocate",
        lambda _descriptor, _offset, length: allocations.append(length),
        raising=False,
    )
    stats = runtime._ImageArchiveStats(
        regular_bytes=1024,
        entries=2,
    )

    with runtime._reserved_extraction_space(tmp_path, stats):
        assert (tmp_path / "extraction-space.reserve").exists()

    assert allocations == [16_384]
    assert checks == [
        (33_792, "extraction"),
        (17_408, "extraction after reservation"),
    ]
    assert not (tmp_path / "extraction-space.reserve").exists()


def test_image_config_preserves_user_environment_and_working_directory(
    tmp_path: Path,
) -> None:
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    (bundle / "config.json").write_text(
        json.dumps(
            {
                "process": {
                    "env": ["PATH=/usr/bin", "SETTING=value"],
                    "cwd": "/workspace",
                    "user": {"uid": 1000, "gid": 2000},
                }
            }
        ),
        encoding="utf-8",
    )

    environment, user, cwd = runtime._load_image_config(bundle)

    assert environment == {"PATH": "/usr/bin", "SETTING": "value"}
    assert (user.uid, user.gid) == (1000, 2000)
    assert cwd == "/workspace"


def test_image_config_rejects_authority_environment(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    (bundle / "config.json").write_text(
        json.dumps(
            {
                "process": {
                    "env": ["HF_TOKEN=decoy"],
                    "cwd": "/",
                    "user": {"uid": 0, "gid": 0},
                }
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(OciImageIntegrityError, match="forbidden authority"):
        runtime._load_image_config(bundle)


def test_rootfs_mapping_strips_setid_bits_and_adds_owner_write(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    rootfs = tmp_path / "rootfs"
    rootfs.mkdir()
    executable = rootfs / "tool"
    executable.write_text("#!/bin/sh\n", encoding="utf-8")
    executable.chmod(0o6755)
    rootfs.chmod(0o555)
    monkeypatch.setattr(runtime.os, "chown", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runtime, "_remove_file_capability", lambda _path: None)

    runtime._sanitize_rootfs(rootfs, os.getuid(), os.getgid())

    assert stat.S_IMODE(executable.stat().st_mode) & 0o6000 == 0
    assert stat.S_IMODE(executable.stat().st_mode) & 0o600 == 0o600
    assert stat.S_IMODE(rootfs.stat().st_mode) & 0o700 == 0o700


def test_rootfs_mapping_rejects_special_files(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    rootfs = tmp_path / "rootfs"
    rootfs.mkdir()
    os.mkfifo(rootfs / "pipe")
    monkeypatch.setattr(runtime.os, "chown", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runtime, "_remove_file_capability", lambda _path: None)

    with pytest.raises(OciImageIntegrityError, match="special file"):
        runtime._sanitize_rootfs(rootfs, os.getuid(), os.getgid())


def test_rootfs_limits_reject_bytes_and_entries_before_mapping(tmp_path: Path) -> None:
    rootfs = tmp_path / "rootfs"
    rootfs.mkdir()
    (rootfs / "large").write_bytes(b"1234")

    with pytest.raises(OciImageIntegrityError, match="aggregate byte"):
        runtime._validate_rootfs_limits(
            rootfs,
            ImageLimits(max_bytes=3, max_entries=10),
        )

    (rootfs / "large").write_bytes(b"")
    (rootfs / "second").write_bytes(b"")
    with pytest.raises(OciImageIntegrityError, match="entry count"):
        runtime._validate_rootfs_limits(
            rootfs,
            ImageLimits(max_bytes=10, max_entries=1),
        )


def test_proot_exposes_only_proc_and_safe_devices(tmp_path: Path) -> None:
    isolated = IsolatedOciRuntime(_TASK_IMAGE, _limits(), _image_limits())
    try:
        passwd = isolated.rootfs / "etc" / "passwd"
        passwd.parent.mkdir()
        passwd.write_text("root:x:0:0:root:/root:/bin/bash\n", encoding="utf-8")
        isolated._image_environment = {"PATH": "/usr/bin"}
        isolated._image_user = runtime._ContainerUser(0, 0, "/root", "root")

        arguments = isolated._proot_arguments(
            "id",
            cwd="/",
            environment={"VISIBLE": "yes"},
            user=0,
        )
    finally:
        _cleanup_runtime(isolated)

    serialized = "\n".join(arguments)
    assert arguments[0:3] == ["proot", "-r", str(isolated.rootfs)]
    assert "/proc:/proc" in arguments
    assert "/dev/null:/dev/null" in arguments
    assert "/run:/run" not in arguments
    assert "/tmp:/tmp" not in arguments
    assert str(isolated.workspace) not in serialized
    assert "harbor-hf-inference.token" not in serialized
    assert "HARBOR_HF_WORKER_CAPABILITY" not in serialized
    assert arguments[arguments.index("-i") : arguments.index("-i") + 2] == ["-i", "0:0"]
    assert "/usr/bin/env" in arguments
    assert "VISIBLE=yes" in arguments


@pytest.mark.parametrize(
    ("contents", "message"),
    [
        (b"x" * 9, "file exceeds"),
        (b"x" * 17, "file exceeds"),
    ],
)
def test_transfer_enforces_individual_and_total_bytes(
    tmp_path: Path,
    contents: bytes,
    message: str,
) -> None:
    source = tmp_path / "source"
    source.write_bytes(contents)

    with pytest.raises(OciTransferError, match=message):
        runtime._scan_transfer_tree(
            source,
            _limits(),
            contents_only=False,
            base_depth=0,
        )


def test_transfer_enforces_count_depth_and_aggregate_bytes(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for index in range(5):
        (source / f"{index}.txt").write_text("", encoding="utf-8")

    with pytest.raises(OciTransferError, match="entry count"):
        runtime._scan_transfer_tree(
            source,
            _limits(),
            contents_only=True,
            base_depth=0,
        )

    shutil.rmtree(source)
    (source / "one" / "two" / "three").mkdir(parents=True)
    (source / "one" / "two" / "three" / "file").write_text("", encoding="utf-8")
    with pytest.raises(OciTransferError, match="path depth"):
        runtime._scan_transfer_tree(
            source,
            _limits(),
            contents_only=True,
            base_depth=0,
        )

    shutil.rmtree(source)
    source.mkdir()
    for index in range(3):
        (source / f"{index}.txt").write_bytes(b"x" * 6)
    with pytest.raises(OciTransferError, match="aggregate size"):
        runtime._scan_transfer_tree(
            source,
            _limits(),
            contents_only=True,
            base_depth=0,
        )


def test_transfer_rejects_links_and_special_files(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    (source / "escape").symlink_to("/etc/passwd")

    with pytest.raises(OciTransferError, match="symbolic link"):
        runtime._scan_transfer_tree(
            source,
            _limits(),
            contents_only=True,
            base_depth=0,
        )

    (source / "escape").unlink()
    os.mkfifo(source / "pipe")
    with pytest.raises(OciTransferError, match="unsupported file"):
        runtime._scan_transfer_tree(
            source,
            _limits(),
            contents_only=True,
            base_depth=0,
        )


def test_task_path_rejects_traversal_and_excess_depth() -> None:
    with pytest.raises(OciTransferError, match="absolute task path"):
        runtime._validate_task_path(
            "/workspace/../secret",
            label="transfer path",
            max_depth=3,
        )
    with pytest.raises(OciTransferError, match="path depth"):
        runtime._validate_task_path(
            "/one/two/three/four",
            label="transfer path",
            max_depth=3,
        )


def test_setpriv_launcher_removes_every_task_privilege() -> None:
    arguments = runtime._setpriv_arguments(["command", "argument"])

    assert arguments == [
        "setpriv",
        "--reuid",
        "60000",
        "--regid",
        "60000",
        "--clear-groups",
        "--no-new-privs",
        "--bounding-set=-all",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--",
        "command",
        "argument",
    ]


def test_uid_freeze_waits_until_proc_reports_stopped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state_reads = 0

    def process_state(_pid: int) -> bool:
        nonlocal state_reads
        state_reads += 1
        return state_reads > 1

    monkeypatch.setattr(runtime, "_task_process_ids", lambda: {123})
    monkeypatch.setattr(runtime, "_task_process_is_stopped", process_state)
    monkeypatch.setattr(os, "kill", lambda _pid, _signal: None)
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)

    assert runtime._stop_task_processes_until_stable() == {123}
    assert state_reads >= 4


def test_upload_rechecks_task_parents_after_uid_freeze(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    isolated = IsolatedOciRuntime(_TASK_IMAGE, _limits(), _image_limits())
    source = tmp_path / "source"
    source.write_text("safe", encoding="utf-8")
    outside = tmp_path / "outside"
    outside.mkdir()
    workspace = isolated.rootfs / "workspace"
    workspace.mkdir()
    original = isolated.rootfs / "workspace-original"
    isolated._running = True

    @contextmanager
    def raced_freeze():
        workspace.rename(original)
        workspace.symlink_to(outside, target_is_directory=True)
        yield

    monkeypatch.setattr(runtime, "_paused_task_processes", raced_freeze)
    try:
        with pytest.raises(OciTransferError, match="symbolic link"):
            asyncio.run(
                isolated.upload_file(
                    source,
                    "/workspace/result",
                    timeout_seconds=5,
                )
            )
        assert not (outside / "result").exists()
    finally:
        _cleanup_runtime(isolated)


def test_preflight_requires_root(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    monkeypatch.setattr(os, "geteuid", lambda: 1000)

    with pytest.raises(OciRuntimeUnavailableError, match="run as root"):
        IsolatedOciRuntime.preflight()


@pytest.mark.parametrize(
    "missing",
    ["proot", "setpriv", "skopeo", "umoci", "zstd", "git"],
)
def test_preflight_requires_every_tool(
    monkeypatch: pytest.MonkeyPatch,
    missing: str,
) -> None:
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    monkeypatch.setattr(
        shutil,
        "which",
        lambda command: None if command == missing else f"/usr/bin/{command}",
    )

    with pytest.raises(OciRuntimeUnavailableError, match=f"required tool {missing}"):
        IsolatedOciRuntime.preflight()


def test_preflight_rejects_task_uid_in_account_database(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runtime.pwd, "getpwuid", lambda _uid: object())

    with pytest.raises(OciRuntimeUnavailableError, match="account database"):
        runtime._validate_unused_task_identity()


def _mock_preflight_until_capabilities(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    monkeypatch.setattr(shutil, "which", lambda command: f"/usr/bin/{command}")
    monkeypatch.setattr(runtime, "_validate_unused_task_identity", lambda: None)


def test_preflight_rejects_effective_ptrace_capability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_preflight_until_capabilities(monkeypatch)
    monkeypatch.setattr(
        runtime,
        "_effective_capabilities",
        lambda _pid: 1 << runtime._CAP_SYS_PTRACE,
    )

    with pytest.raises(OciRuntimeUnavailableError, match="CAP_SYS_PTRACE"):
        IsolatedOciRuntime.preflight()


def test_preflight_classifies_security_probe_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_preflight_until_capabilities(monkeypatch)
    monkeypatch.setattr(runtime, "_effective_capabilities", lambda _pid: 0)
    monkeypatch.setattr(runtime, "_run_preflight_command", lambda _args, _label: None)

    def fail_probe() -> None:
        raise OciRuntimeUnavailableError("probe could read root secret")

    monkeypatch.setattr(runtime, "_run_security_probe", fail_probe)

    with pytest.raises(OciRuntimeUnavailableError, match="root secret"):
        IsolatedOciRuntime.preflight()


@pytest.mark.skipif(
    not _linux_task_uid_available(),
    reason="requires root Linux with the dedicated UID unused",
)
def test_linux_task_identity_cannot_read_root_or_regain_root(tmp_path: Path) -> None:
    secret = tmp_path / "secret"
    secret.write_text("private", encoding="utf-8")
    secret.chmod(0o600)
    script = (
        "import json, os, pathlib, sys\n"
        "blocked = []\n"
        "for path in sys.argv[1:]:\n"
        "    try:\n"
        "        pathlib.Path(path).read_bytes()\n"
        "    except PermissionError:\n"
        "        blocked.append(path)\n"
        "try:\n"
        "    os.setuid(0)\n"
        "except PermissionError:\n"
        "    setuid_blocked = True\n"
        "else:\n"
        "    setuid_blocked = False\n"
        "status = {}\n"
        "for line in pathlib.Path('/proc/self/status').read_text().splitlines():\n"
        "    name, separator, value = line.partition(':')\n"
        "    if separator:\n"
        "        status[name] = value.strip()\n"
        "print(json.dumps({'blocked': blocked, 'groups': os.getgroups(), "
        "'no_new_privs': status['NoNewPrivs'], 'cap_eff': status['CapEff'], "
        "'cap_bnd': status['CapBnd'], 'setuid_blocked': setuid_blocked, "
        "'uid': os.getuid(), 'gid': os.getgid()}))\n"
    )

    result = subprocess.run(
        runtime._setpriv_arguments(
            [
                sys.executable,
                "-c",
                script,
                str(secret),
                f"/proc/{os.getpid()}/environ",
            ]
        ),
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    value = json.loads(result.stdout)

    assert value == {
        "blocked": [str(secret), f"/proc/{os.getpid()}/environ"],
        "groups": [],
        "no_new_privs": "1",
        "cap_eff": "0000000000000000",
        "cap_bnd": "0000000000000000",
        "setuid_blocked": True,
        "uid": runtime._TASK_UID,
        "gid": runtime._TASK_GID,
    }


@pytest.mark.skipif(
    not _linux_task_uid_available(),
    reason="requires root Linux with the dedicated UID unused",
)
def test_linux_cleanup_kills_setsid_descendant() -> None:
    pid_path = Path(f"/tmp/harbor-hf-task-pids-{uuid.uuid4().hex}")
    script = (
        "import os, pathlib, time\n"
        "child = os.fork()\n"
        "if child == 0:\n"
        "    os.setsid()\n"
        "    while True:\n"
        "        time.sleep(1)\n"
        "pathlib.Path(os.environ['PID_PATH']).write_text("
        "f'{os.getpid()} {child}')\n"
        "while True:\n"
        "    time.sleep(1)\n"
    )
    process = subprocess.Popen(
        runtime._setpriv_arguments([sys.executable, "-c", script]),
        env={"PID_PATH": str(pid_path), "PATH": os.environ["PATH"]},
    )
    try:
        deadline = time.monotonic() + 5
        while not pid_path.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        parent_pid, child_pid = (int(value) for value in pid_path.read_text().split())

        runtime._kill_task_processes()

        process.wait(timeout=5)
        assert not Path(f"/proc/{parent_pid}").exists()
        assert not Path(f"/proc/{child_pid}").exists()
        assert not runtime._task_process_ids()
    finally:
        pid_path.unlink(missing_ok=True)
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
