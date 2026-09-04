import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
MARKDOWN_LINK = re.compile(r"!?\[[^\]]*\]\((?P<target><[^>]+>|[^\s)]+)")
REFERENCE_LINK = re.compile(r"^\s*\[[^\]]+\]:\s*(?P<target><[^>]+>|\S+)", re.MULTILINE)
IGNORED_DIRECTORIES = {".git", ".harbor-hf", ".venv", "node_modules", "test-results"}


def markdown_files() -> list[Path]:
    return sorted(
        path
        for path in ROOT.rglob("*.md")
        if not any(part in IGNORED_DIRECTORIES for part in path.parts)
    )


def local_target(raw: str) -> str | None:
    target = raw.removeprefix("<").removesuffix(">").strip()
    if not target or target.startswith(("#", "/")):
        return None
    parsed = urlsplit(target)
    if parsed.scheme or parsed.netloc:
        return None
    path = unquote(parsed.path)
    if not path or any(marker in path for marker in ("{", "}", "*")):
        return None
    return path


def test_relative_markdown_links_resolve() -> None:
    broken: list[str] = []
    for document in markdown_files():
        text = document.read_text(encoding="utf-8")
        matches = [*MARKDOWN_LINK.finditer(text), *REFERENCE_LINK.finditer(text)]
        for match in matches:
            target = local_target(match.group("target"))
            if target is None:
                continue
            resolved = (document.parent / target).resolve()
            if not resolved.exists():
                line = text.count("\n", 0, match.start()) + 1
                broken.append(f"{document.relative_to(ROOT)}:{line} -> {target}")
    assert not broken, "Broken relative Markdown links:\n" + "\n".join(broken)
