from pathlib import Path
from typing import cast

import yaml

ROOT = Path(__file__).parents[1]
README = ROOT / "deploy" / "control-space" / "README.md"


def _frontmatter() -> dict[str, object]:
    text = README.read_text(encoding="utf-8")
    assert text.startswith("---\n")
    _, frontmatter, _ = text.split("---\n", 2)
    parsed = yaml.safe_load(frontmatter)
    assert isinstance(parsed, dict)
    return cast(dict[str, object], parsed)


def test_control_space_requests_only_reviewed_execution_scopes() -> None:
    metadata = _frontmatter()

    assert metadata["hf_oauth"] is True
    # Identity scopes are included by HF. Do not request broad repository
    # management rights on the assumption that they cover private Buckets.
    assert metadata["hf_oauth_scopes"] == ["jobs", "inference-api"]
