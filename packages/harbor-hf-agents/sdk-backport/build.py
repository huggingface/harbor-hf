"""Repack the released SDK wheel with the reviewed SDK backports."""

import argparse
import base64
import csv
import hashlib
import io
import subprocess
import tempfile
import tomllib
import zipfile
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
SOURCE_URL = (
    "https://files.pythonhosted.org/packages/51/0e/"
    "eafef18f1a75e125e68395db21131db0cf868a128ecd2fce69b4df6c584b/"
    "huggingface_hub-1.28.0-py3-none-any.whl"
)
SOURCE_SHA256 = "58a8bacb03072edfc38067065e9dc24bbb34805410fcd36a1632de0b329660bb"


def repack(source: bytes, version: str, patch: Path) -> bytes:
    """Verify before extracting; use fixed ZIP metadata and regenerate RECORD."""
    if hashlib.sha256(source).hexdigest() != SOURCE_SHA256:
        raise ValueError("SDK release wheel hash mismatch")
    with zipfile.ZipFile(io.BytesIO(source)) as archive:
        files = {name: archive.read(name) for name in archive.namelist()}
    modules = ("huggingface_hub/_sandbox.py", "huggingface_hub/_jobs_api.py")
    with tempfile.TemporaryDirectory() as directory:
        for sdk in modules:
            target = Path(directory) / sdk
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(files[sdk])
        subprocess.run(
            ["git", "apply", "--no-index", "-p2", str(patch.resolve())],
            cwd=directory,
            check=True,
        )
        subprocess.run(
            [
                "git",
                "apply",
                "--no-index",
                "-p2",
                str((ROOT / "job-name.patch").resolve()),
            ],
            cwd=directory,
            check=True,
        )
        for sdk in modules:
            files[sdk] = (Path(directory) / sdk).read_bytes()
    init = "huggingface_hub/__init__.py"
    files[init] = files[init].replace(
        b'__version__ = "1.28.0"', f'__version__ = "{version}"'.encode()
    )
    old_info = "huggingface_hub-1.28.0.dist-info"
    info = f"huggingface_hub-{version}.dist-info"
    files = {name.replace(old_info, info): data for name, data in files.items()}
    metadata = f"{info}/METADATA"
    files[metadata] = files[metadata].replace(
        b"Version: 1.28.0\n", f"Version: {version}\n".encode()
    )
    record = f"{info}/RECORD"
    del files[record]
    rows = io.StringIO(newline="")
    writer = csv.writer(rows, lineterminator="\n")
    for name, data in sorted(files.items()):
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
        writer.writerow((name, f"sha256={digest.decode()}", len(data)))
    writer.writerow((record, "", ""))
    files[record] = rows.getvalue().encode()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in sorted(files.items()):
            entry = zipfile.ZipInfo(name, date_time=(2026, 9, 9, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, data)
    return output.getvalue()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source", type=Path, help="Offline release wheel (hash checked)"
    )
    args = parser.parse_args()
    config = tomllib.loads((ROOT.parent / "pyproject.toml").read_text())
    dependency = next(
        item
        for item in config["project"]["dependencies"]
        if item.startswith("huggingface-hub==")
    )
    version = dependency.split("==")[1]
    if args.source is not None:
        source = args.source.read_bytes()
    else:
        with urlopen(SOURCE_URL, timeout=60) as response:
            source = response.read()
    wheel = repack(source, version, ROOT / "terminal-result.patch")
    output = ROOT / "dist" / f"huggingface_hub-{version}-py3-none-any.whl"
    output.parent.mkdir(exist_ok=True)
    (output.parent / "huggingface_hub-1.28.0-py3-none-any.whl").write_bytes(source)
    output.write_bytes(wheel)
    print(f"{output.name} sha256:{hashlib.sha256(wheel).hexdigest()}")


if __name__ == "__main__":
    main()
