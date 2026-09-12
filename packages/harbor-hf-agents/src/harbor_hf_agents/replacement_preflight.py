"""Read only source evidence with the parent's existing SDK authentication."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory

from harbor.models.job.config import JobConfig
from huggingface_hub import BucketFile

from harbor_hf_agents import launch
from harbor_hf_agents.bucket_artifacts import BucketArtifacts
from harbor_hf_agents.replacement_evidence import (
    RUN_ID,
    Evidence,
    derive,
    native,
)
from harbor_hf_agents.replacements import ancestry, validate_ancestry


def _source_files(artifacts: BucketArtifacts, run_id: str) -> list[str]:
    prefix = f"runs/{run_id}/job/"
    paths = [
        item.path
        for item in artifacts.api.list_bucket_tree(
            artifacts.bucket_id, prefix=prefix, recursive=True
        )
        if isinstance(item, BucketFile)
    ]
    names: set[str] = set()
    results: set[str] = set()
    for path in paths:
        if not path.startswith(prefix):
            raise ValueError("Source listing escaped its run")
        relative = PurePosixPath(path.removeprefix(prefix))
        if ".." in relative.parts or relative.is_absolute():
            raise ValueError("Invalid source artifact path")
        if len(relative.parts) > 1:
            names.add(relative.parts[0])
            if len(relative.parts) == 2 and relative.name == "result.json":
                results.add(relative.parts[0])
    if not names or names != results:
        raise ValueError("Source has unfinished artifact membership")
    return [f"{prefix}{name}/result.json" for name in sorted(results)]


def read_source(artifacts: BucketArtifacts, run_id: str, temporary: Path) -> Evidence:
    from harbor_hf_agents.parent_worker import load_run_record

    if not RUN_ID.fullmatch(run_id) or run_id == artifacts.run_dir.name:
        raise ValueError("Invalid replacement source run")
    prefix = f"runs/{run_id}"
    files = [
        f"{prefix}/run.json",
        *(f"{prefix}/job/{name}.json" for name in ("config", "lock", "result")),
        *_source_files(artifacts, run_id),
    ]
    transfers: list[tuple[str | BucketFile, str | Path]] = [
        (path, temporary / path) for path in files
    ]
    for _, path in transfers:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    artifacts.api.download_bucket_files(
        artifacts.bucket_id, transfers, raise_on_missing_files=True
    )
    job = temporary / prefix / "job"
    bundle = {
        "record": load_run_record(temporary, run_id),
        **{
            name: json.loads((job / f"{name}.json").read_text())
            for name in ("config", "lock", "result")
        },
        "trials": [json.loads((temporary / path).read_text()) for path in files[4:]],
    }
    source = Evidence.parse(bundle)
    if any(
        PurePosixPath(path).parent.name != trial.trial_name
        for path, trial in zip(files[4:], source.trials, strict=True)
    ):
        raise ValueError(
            "Native trial identity does not match its source artifact path"
        )
    return source


def validate_preflight(
    artifacts: BucketArtifacts, record: dict[str, object], config: JobConfig
) -> None:
    selection = launch.record(record["operator_selection"])
    # This directory is deliberately not under the replacement run or job tree.
    with TemporaryDirectory(prefix="harbor-replacement-review-") as directory:
        temporary = Path(directory)
        if temporary.resolve().is_relative_to(artifacts.run_dir.resolve()):
            raise ValueError("Source evidence must stay outside replacement storage")
        source = read_source(artifacts, str(selection["original_run_id"]), temporary)
        chain = ancestry(
            source, lambda run_id: read_source(artifacts, run_id, temporary)
        )
        private, _ = asyncio.run(validate_ancestry(chain))
        selected = source.select(selection["trial_ids"])
        if selection.get("source_fingerprint") != source.fingerprint(selected):
            raise ValueError("Replacement source fingerprint mismatch")
        expected = derive(
            source, selected, artifacts.run_dir.name, artifacts.run_dir.parents[1]
        )
        if native(config) != native(expected) or native(
            JobConfig.model_validate(record["harbor_job_config"])
        ) != native(expected):
            raise ValueError("Parent replacement configuration differs from review")
        for task in config.tasks:
            launch.check_task(task, private)


async def preflight(
    artifacts: BucketArtifacts, record: dict[str, object], config: JobConfig
) -> None:
    await asyncio.to_thread(validate_preflight, artifacts, record, config)
