from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from harbor_hf.benchmark_source import (
    BenchmarkSourceLock,
    load_source_lock,
    resolved_experiment,
    source_lock_bytes,
)
from harbor_hf.campaigns import CampaignLock, build_campaign_lock, build_campaign_plan
from harbor_hf.io import load_experiment
from harbor_hf.models import ExperimentSpec

_INPUT_FILES = ("campaign.lock.json", "manifest.yaml", "source.lock.json")


class FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class InputFile(FrozenModel):
    bytes: int = Field(ge=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class CampaignInputManifest(FrozenModel):
    schema_version: Literal["harbor-hf/campaign-input/v1alpha1"] = (
        "harbor-hf/campaign-input/v1alpha1"
    )
    campaign_id: str
    plan_digest: str
    files: dict[str, InputFile]
    input_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")

    @model_validator(mode="after")
    def file_set_is_exact(self) -> CampaignInputManifest:
        if tuple(sorted(self.files)) != _INPUT_FILES:
            raise ValueError("campaign input manifest has an unexpected file set")
        expected = campaign_input_digest(self.files)
        if self.input_digest != expected:
            raise ValueError("campaign input digest does not match its files")
        return self


class ValidatedCampaignInput(FrozenModel):
    requested_spec: ExperimentSpec
    spec: ExperimentSpec
    source_lock: BenchmarkSourceLock
    lock: CampaignLock
    manifest: CampaignInputManifest


def write_campaign_input(
    destination: Path,
    *,
    request: bytes,
    lock: CampaignLock,
) -> CampaignInputManifest:
    if destination.exists():
        if destination.is_symlink() or not destination.is_dir():
            raise ValueError("campaign input destination must be a real directory")
        if any(destination.iterdir()):
            raise ValueError("campaign input destination must be empty")
    destination.mkdir(parents=True, exist_ok=True)
    manifest_path = destination / "manifest.yaml"
    source_lock_path = destination / "source.lock.json"
    lock_path = destination / "campaign.lock.json"
    manifest_path.write_bytes(request)
    source_lock_path.write_bytes(source_lock_bytes(lock.source_lock))
    lock_path.write_text(
        json.dumps(lock.model_dump(mode="json"), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    files = {
        path.name: _file_record(path)
        for path in sorted(
            (lock_path, manifest_path, source_lock_path), key=lambda value: value.name
        )
    }
    input_manifest = CampaignInputManifest(
        campaign_id=lock.campaign_id,
        plan_digest=lock.plan_digest,
        files=files,
        input_digest=campaign_input_digest(files),
    )
    (destination / "input-manifest.json").write_text(
        json.dumps(input_manifest.model_dump(mode="json"), indent=2, sort_keys=True)
        + "\n",
        encoding="utf-8",
    )
    return input_manifest


def validate_campaign_input(root: Path) -> ValidatedCampaignInput:
    _validate_campaign_input_paths(root)
    input_manifest = CampaignInputManifest.model_validate_json(
        (root / "input-manifest.json").read_text(encoding="utf-8")
    )
    for name, expected in input_manifest.files.items():
        if _file_record(root / name) != expected:
            raise ValueError(f"campaign input file does not match its digest: {name}")
    requested_spec = load_experiment(root / "manifest.yaml")
    source_lock = load_source_lock(root / "source.lock.json")
    spec = resolved_experiment(requested_spec, source_lock)
    lock = CampaignLock.model_validate_json(
        (root / "campaign.lock.json").read_text(encoding="utf-8")
    )
    if source_lock != lock.source_lock:
        raise ValueError("campaign input source lock does not match its campaign")
    expected_lock = build_campaign_lock(
        build_campaign_plan(
            requested_spec,
            source_lock=source_lock,
            recovery_policy=lock.recovery_policy,
        ),
        lock.campaign_id,
        clock=lambda: lock.created_at,
    )
    if lock != expected_lock:
        raise ValueError("campaign input lock is not reproducible from its manifest")
    if (
        input_manifest.campaign_id != lock.campaign_id
        or input_manifest.plan_digest != lock.plan_digest
    ):
        raise ValueError("campaign input identity does not match its lock")
    return ValidatedCampaignInput(
        requested_spec=requested_spec,
        spec=spec,
        source_lock=source_lock,
        lock=lock,
        manifest=input_manifest,
    )


def _validate_campaign_input_paths(root: Path) -> None:
    if root.is_symlink() or not root.is_dir():
        raise ValueError("campaign input root must be a real directory")
    entries = sorted(root.iterdir(), key=lambda path: path.name)
    if any(path.is_symlink() or not path.is_file() for path in entries):
        raise ValueError("campaign input cannot contain symlinks or directories")
    if [path.name for path in entries] != [
        "campaign.lock.json",
        "input-manifest.json",
        "manifest.yaml",
        "source.lock.json",
    ]:
        raise ValueError("campaign input must contain exactly four files")


def campaign_input_json_schema() -> dict[str, object]:
    return CampaignInputManifest.model_json_schema()


def campaign_input_digest(files: dict[str, InputFile]) -> str:
    payload = json.dumps(
        {name: files[name].model_dump(mode="json") for name in sorted(files)},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _file_record(path: Path) -> InputFile:
    content = path.read_bytes()
    return InputFile(bytes=len(content), sha256=hashlib.sha256(content).hexdigest())
