"""Reproducibility/source audit; run sdk-backport/build.py before this suite."""

import base64
import csv
import hashlib
import importlib.util
import io
import subprocess
import sys
import tomllib
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
BACKPORT = ROOT / "sdk-backport"
SPEC = importlib.util.spec_from_file_location("sdk_build", BACKPORT / "build.py")
assert SPEC is not None and SPEC.loader is not None
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


def test_hash_rejected_before_patch():
    with pytest.raises(ValueError, match="hash mismatch"):
        BUILD.repack(b"untrusted", "unused", Path("missing.patch"))


def test_reproducible_wheel_and_narrow_source_diff(tmp_path):
    lock = tomllib.loads((ROOT / "uv.lock").read_text())
    sdk = next(p for p in lock["package"] if p["name"] == "huggingface-hub")
    source = (BACKPORT / "dist/huggingface_hub-1.28.0-py3-none-any.whl").read_bytes()
    wheel = BUILD.repack(source, sdk["version"], BACKPORT / "terminal-result.patch")
    assert wheel == (ROOT / sdk["source"]["path"]).read_bytes()
    assert sdk["wheels"][0]["hash"] == f"sha256:{hashlib.sha256(wheel).hexdigest()}"
    with zipfile.ZipFile(io.BytesIO(source)) as original:
        before = {n: original.read(n) for n in original.namelist()}
    with zipfile.ZipFile(io.BytesIO(wheel)) as patched:
        after = {n: patched.read(n) for n in patched.namelist()}
    normalized = {n.replace(sdk["version"], "1.28.0"): v for n, v in after.items()}
    assert before.keys() == normalized.keys()
    assert {n for n in before if before[n] != normalized[n]} == {
        "huggingface_hub/_sandbox.py",
        "huggingface_hub/_jobs_api.py",
        "huggingface_hub/__init__.py",
        "huggingface_hub-1.28.0.dist-info/METADATA",
        "huggingface_hub-1.28.0.dist-info/RECORD",
    }
    assert (
        normalized["huggingface_hub/_sandbox.py"].replace(
            b"                    # Exit is terminal: a truncated HTTP tail must not "
            b"mask the command result.\n                    break\n",
            b"",
        )
        == before["huggingface_hub/_sandbox.py"]
    )
    assert (
        normalized["huggingface_hub/_jobs_api.py"].replace(
            b"        # Drop registry host, namespace and digest "
            b"from the readable name only.\n"
            b'        base = _sanitize_job_name(image.split("@", 1)[0]'
            b'.rstrip("/").split("/")[-1] or image)',
            b'        base = _sanitize_job_name(image.rstrip("/").split("/")[-1] '
            b"or image)  # drop registry host and namespace",
        )
        == before["huggingface_hub/_jobs_api.py"]
    )
    for name in (
        "huggingface_hub/__init__.py",
        "huggingface_hub-1.28.0.dist-info/METADATA",
    ):
        assert (
            normalized[name].replace(sdk["version"].encode(), b"1.28.0") == before[name]
        )
    record = next(n for n in after if n.endswith(".dist-info/RECORD"))
    for name, digest, size in csv.reader(io.StringIO(after[record].decode())):
        if name == record:
            assert digest == size == ""
        else:
            expected = base64.urlsafe_b64encode(hashlib.sha256(after[name]).digest())
            assert digest == "sha256=" + expected.rstrip(b"=").decode()
            assert int(size) == len(after[name])
    bad_patch = tmp_path / "bad.patch"
    bad_patch.write_text("not a patch")
    with pytest.raises(subprocess.CalledProcessError):
        BUILD.repack(source, sdk["version"], bad_patch)


@pytest.mark.parametrize("offline", [True, False])
def test_build_entrypoint(offline, tmp_path, monkeypatch, capsys):
    source = BACKPORT / "dist/huggingface_hub-1.28.0-py3-none-any.whl"
    root = tmp_path / "sdk-backport"
    root.mkdir()
    (tmp_path / "pyproject.toml").write_bytes((ROOT / "pyproject.toml").read_bytes())
    (root / "terminal-result.patch").write_bytes(
        (BACKPORT / "terminal-result.patch").read_bytes()
    )
    (root / "job-name.patch").write_bytes((BACKPORT / "job-name.patch").read_bytes())
    monkeypatch.setattr(BUILD, "ROOT", root)
    monkeypatch.setattr(
        sys, "argv", ["build.py"] + (["--source", str(source)] if offline else [])
    )

    def fetch(url, timeout):
        assert url == BUILD.SOURCE_URL and timeout == 60
        return io.BytesIO(source.read_bytes())

    monkeypatch.setattr(BUILD, "urlopen", fetch)
    BUILD.main()
    wheel = (
        root
        / "dist"
        / "huggingface_hub-1.28.0+terminal.f1c01f0.jobname.3493b0d-py3-none-any.whl"
    )
    assert wheel.read_bytes() == (BACKPORT / "dist" / wheel.name).read_bytes()
    assert (
        "sha256:fdd23ace680c9c09aafab55e88e888c6b314cf21808cc4601ec548a86a0a0e1b"
        in capsys.readouterr().out
    )
