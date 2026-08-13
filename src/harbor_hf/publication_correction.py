from __future__ import annotations

import hashlib
import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from harbor_hf.control import CampaignSnapshot
from harbor_hf.io import load_manifest_object_bytes
from harbor_hf.models import ContentDigest, PublicationVisibility


class PublicationCorrection(BaseModel):
    """Explicit artifact-only publication target for one immutable campaign."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["harbor-hf/publication-correction/v1"] = (
        "harbor-hf/publication-correction/v1"
    )
    campaign_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    source_manifest_digest: ContentDigest
    source_plan_digest: ContentDigest
    result_dataset: str = Field(pattern=r"^[^/]+/[^/]+$")
    result_dataset_visibility: PublicationVisibility
    index_dataset: str = Field(pattern=r"^[^/]+/[^/]+$")
    index_dataset_visibility: PublicationVisibility

    @model_validator(mode="after")
    def datasets_are_distinct(self) -> PublicationCorrection:
        if self.result_dataset == self.index_dataset:
            raise ValueError("result and index Datasets must be distinct")
        return self


def load_publication_correction_bytes(
    content: bytes,
    *,
    source: str,
) -> PublicationCorrection:
    return PublicationCorrection.model_validate(
        load_manifest_object_bytes(content, source=source)
    )


def publication_correction_digest(correction: PublicationCorrection) -> ContentDigest:
    payload = publication_correction_bytes(correction)
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


def publication_correction_bytes(correction: PublicationCorrection) -> bytes:
    return json.dumps(
        correction.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
    ).encode()


def publication_correction_json_schema() -> dict[str, object]:
    return PublicationCorrection.model_json_schema()


def validate_publication_correction(
    snapshot: CampaignSnapshot,
    correction: PublicationCorrection,
    namespace: str,
) -> str:
    """Validate source identity and return its immutable artifact Bucket."""
    if snapshot.lock.campaign_id != correction.campaign_id:
        raise ValueError(
            "publication correction campaign ID does not match its snapshot"
        )
    if snapshot.lock.manifest_digest != correction.source_manifest_digest:
        raise ValueError("publication correction source manifest digest does not match")
    if snapshot.lock.plan_digest != correction.source_plan_digest:
        raise ValueError("publication correction source plan digest does not match")
    request = load_manifest_object_bytes(
        snapshot.request,
        source=f"campaign {snapshot.lock.campaign_id} request",
    )
    return _validate_legacy_publication_request(request, namespace)


def _validate_legacy_publication_request(
    request: dict[str, object], namespace: str
) -> str:
    publishing = request.get("publishing")
    if not isinstance(publishing, dict):
        raise ValueError("campaign request publishing section is invalid")
    if "dataset_visibility" in publishing or "index_dataset_visibility" in publishing:
        raise ValueError(
            "publication correction is only for requests without visibility fields"
        )
    artifacts = request.get("artifacts")
    bucket = artifacts.get("bucket") if isinstance(artifacts, dict) else None
    if not isinstance(bucket, str):
        raise ValueError("campaign request artifact store is invalid")
    remote = request.get("remote")
    job = remote.get("job") if isinstance(remote, dict) else None
    if not isinstance(job, dict) or job.get("namespace") != namespace:
        raise ValueError("campaign request does not match the control namespace")
    return bucket
