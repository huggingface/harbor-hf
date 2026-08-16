import os
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "check_public_privacy.py"


def run_check(
    root: Path, *, denylist: tuple[str, ...] = ()
) -> subprocess.CompletedProcess[str]:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "add", "."], cwd=root, check=True)
    env = os.environ.copy()
    env["PUBLIC_PRIVACY_DENYLIST"] = "\n".join(denylist)
    return subprocess.run(
        [sys.executable, str(SCRIPT), str(root)],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )


def test_allows_public_placeholders(tmp_path: Path) -> None:
    text = "\n".join(
        (
            "/home/user/repo",
            "operator@example.com",
            "https://huggingface.co/spaces/example-org/example-space",
            "hf://buckets/example-org/example-bucket/objects/item.json",
            "<namespace>/<artifact-bucket>",
        )
    )
    (tmp_path / "example.md").write_text(text)

    result = run_check(tmp_path)

    assert result.returncode == 0
    assert result.stdout == "public privacy check passed\n"


def test_rejects_operator_identifiers_without_echoing_values(tmp_path: Path) -> None:
    private_home = "/" + "home" + "/private-user/repo"
    private_email = "person" + "@company.com"
    private_space = "https://huggingface.co/" + "spaces/private-user/private-space"
    private_bucket = "hf://" + "buckets/private-user/private-bucket/item.json"
    private_values = (private_home, private_email, private_space, private_bucket)
    (tmp_path / "private.md").write_text("\n".join(private_values))

    result = run_check(tmp_path)

    assert result.returncode == 1
    assert "operator-specific home path" in result.stdout
    assert "personal email address" in result.stdout
    assert "operator-specific Hugging Face resource URL" in result.stdout
    assert "operator-specific Hugging Face Bucket URI" in result.stdout
    assert not any(value in result.stdout for value in private_values)


def test_private_denylist_reports_only_category(tmp_path: Path) -> None:
    private_identifier = "private" + "-operator-id"
    (tmp_path / "private.md").write_text(f"value={private_identifier}")

    result = run_check(tmp_path, denylist=(private_identifier,))

    assert result.returncode == 1
    assert "private denylist match" in result.stdout
    assert private_identifier not in result.stdout
