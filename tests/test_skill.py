from pathlib import Path


def test_harbor_hf_skill_matches_the_harbor_centered_contract() -> None:
    skill = Path(".agents/skills/harbor-hf/SKILL.md").read_text(encoding="utf-8")
    assert "name: harbor-hf" in skill
    assert "harbor-hf submit" in skill
    assert "harbor-hf run pause" in skill
    assert "harbor-hf run resume" in skill
    assert "one private control Space" in skill
    assert "one private Bucket" in skill
    assert "three-table" in skill
    for removed in (
        "launch-policy",
        "worker capability",
        "publication receipts",
        "inference bridge",
        "harbor-hf endpoints",
        "harbor-hf results",
    ):
        assert removed not in skill
