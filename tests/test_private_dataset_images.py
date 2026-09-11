from pathlib import Path

ROOT = Path(__file__).parents[1]


def test_control_runtime_image_includes_git_lfs() -> None:
    dockerfile = (ROOT / "deploy/control-space/Dockerfile").read_text(encoding="utf-8")
    runtime = dockerfile.split(" AS runtime\n", 1)[1]

    assert "git-lfs" in runtime
    assert "git lfs version" in runtime


def test_parent_image_includes_git_lfs() -> None:
    dockerfile = (ROOT / "deploy/parent-worker/Dockerfile").read_text(encoding="utf-8")

    assert "git-lfs" in dockerfile
    assert "git lfs version" in dockerfile
