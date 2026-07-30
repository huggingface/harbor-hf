import json
from pathlib import Path

import pytest

from harbor_hf.campaign_input import validate_campaign_input, write_campaign_input
from harbor_hf.campaigns import build_campaign_lock, build_campaign_plan
from harbor_hf.models import ExperimentSpec


def _input(tmp_path: Path, remote_manifest: Path, remote_spec: ExperimentSpec) -> Path:
    lock = build_campaign_lock(build_campaign_plan(remote_spec), "campaign-input")
    root = tmp_path / "campaign-input"
    write_campaign_input(
        root,
        request=remote_manifest.read_bytes(),
        lock=lock,
    )
    return root


def test_campaign_input_is_exact_content_addressed_and_reproducible(
    tmp_path: Path,
    remote_manifest: Path,
    remote_spec: ExperimentSpec,
) -> None:
    root = _input(tmp_path, remote_manifest, remote_spec)

    validated = validate_campaign_input(root)

    assert validated.lock.campaign_id == "campaign-input"
    assert validated.manifest.plan_digest == validated.lock.plan_digest
    assert set(validated.manifest.files) == {"campaign.lock.json", "manifest.yaml"}
    assert validated.manifest.input_digest.startswith("sha256:")
    assert set(path.name for path in root.iterdir()) == {
        "campaign.lock.json",
        "input-manifest.json",
        "manifest.yaml",
    }


def test_campaign_input_rejects_extra_files_symlinks_and_changed_bytes(
    tmp_path: Path,
    remote_manifest: Path,
    remote_spec: ExperimentSpec,
) -> None:
    root = _input(tmp_path, remote_manifest, remote_spec)
    (root / "extra.txt").write_text("unexpected", encoding="utf-8")
    with pytest.raises(ValueError, match="exactly three files"):
        validate_campaign_input(root)
    (root / "extra.txt").unlink()

    manifest = root / "manifest.yaml"
    manifest.write_bytes(manifest.read_bytes() + b"\n")
    with pytest.raises(ValueError, match="does not match its digest"):
        validate_campaign_input(root)

    manifest.write_bytes(remote_manifest.read_bytes())
    link = root / "extra-link"
    link.symlink_to(root / "manifest.yaml")
    with pytest.raises(ValueError, match="symlinks"):
        validate_campaign_input(root)


def test_campaign_input_rejects_a_mismatched_identity(
    tmp_path: Path,
    remote_manifest: Path,
    remote_spec: ExperimentSpec,
) -> None:
    root = _input(tmp_path, remote_manifest, remote_spec)
    path = root / "input-manifest.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    value["campaign_id"] = "other-campaign"
    path.write_text(json.dumps(value), encoding="utf-8")

    with pytest.raises(ValueError, match="identity does not match"):
        validate_campaign_input(root)
