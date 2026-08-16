"""Reject operator-specific identifiers from this public repository."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

HOME_PATH = re.compile(r"(?<![\w.-])/(?:home|Users)/([^/\s\"'`]+)")
EMAIL = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE)
HF_RESOURCE_URL = re.compile(
    r"huggingface\.co/(?:spaces|datasets)/([^/\s)>`]+)", re.IGNORECASE
)
HF_BUCKET_URI = re.compile(r"hf://buckets/([^/\s\"'`]+)", re.IGNORECASE)
URL_USERINFO = re.compile(r"https?://[^/\s]+@", re.IGNORECASE)

_ALLOWED_HOME_USERS = {"user", "example", "<user>", "$USER", "${USER}"}
_ALLOWED_HF_NAMESPACES = {
    "example-org",
    "<namespace>",
    "huggingface",
    "input",
    "org",
    "private-evidence",
}
_PLACEHOLDER_CHARS = frozenset("{}[]()^\\*+?")


@dataclass(frozen=True)
class Finding:
    path: Path
    line: int
    category: str


def _hf_namespace_is_placeholder(value: str) -> bool:
    return (
        value in _ALLOWED_HF_NAMESPACES
        or value.isupper()
        or bool(_PLACEHOLDER_CHARS.intersection(value))
    )


def _email_is_example(value: str) -> bool:
    local, domain = value.rsplit("@", 1)
    domain = domain.lower()
    return (
        domain == "example.com"
        or domain.endswith(".example")
        or (local == "git" and domain in {"github.com", "gitlab.com"})
    )


def _line_categories(line: str, denylist: tuple[str, ...]) -> list[str]:
    email_line = URL_USERINFO.sub("https://", line)
    checks = (
        (
            any(value and value.casefold() in line.casefold() for value in denylist),
            "private denylist match",
        ),
        (
            any(
                match.group(1) not in _ALLOWED_HOME_USERS
                for match in HOME_PATH.finditer(line)
            ),
            "operator-specific home path",
        ),
        (
            any(
                not _email_is_example(match.group(0))
                for match in EMAIL.finditer(email_line)
            ),
            "personal email address",
        ),
        (
            any(
                not _hf_namespace_is_placeholder(match.group(1))
                for match in HF_RESOURCE_URL.finditer(line)
            ),
            "operator-specific Hugging Face resource URL",
        ),
        (
            any(
                not _hf_namespace_is_placeholder(match.group(1))
                for match in HF_BUCKET_URI.finditer(line)
            ),
            "operator-specific Hugging Face Bucket URI",
        ),
    )
    return [category for matched, category in checks if matched]


def find_privacy_violations(
    path: Path, text: str, *, denylist: tuple[str, ...] = ()
) -> list[Finding]:
    """Return findings without echoing the matched private value."""

    return [
        Finding(path, number, category)
        for number, line in enumerate(text.splitlines(), start=1)
        for category in _line_categories(line, denylist)
    ]


def _tracked_files(root: Path) -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=root,
        check=True,
        capture_output=True,
    )
    return [root / name.decode() for name in result.stdout.split(b"\0") if name]


def check_repository(root: Path, *, denylist: tuple[str, ...] = ()) -> list[Finding]:
    findings: list[Finding] = []
    for path in _tracked_files(root):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        findings.extend(
            find_privacy_violations(path.relative_to(root), text, denylist=denylist)
        )
    return findings


def _private_denylist() -> tuple[str, ...]:
    return tuple(
        value.strip()
        for value in os.environ.get("PUBLIC_PRIVACY_DENYLIST", "").splitlines()
        if value.strip()
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", type=Path, default=Path.cwd())
    args = parser.parse_args()

    findings = check_repository(args.root.resolve(), denylist=_private_denylist())
    for finding in findings:
        print(f"{finding.path}:{finding.line}: {finding.category}")
    if findings:
        print(f"public privacy check failed with {len(findings)} finding(s)")
        return 1
    print("public privacy check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
