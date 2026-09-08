"""Read-only launch inspection using the pinned Harbor package's public APIs.

This module never constructs an agent instance, installs source code, or starts a Job.
The caller supplies a clean environment and a disposable working directory.
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib.metadata
import json
import re
import sys
from pathlib import Path, PurePosixPath
from typing import cast
from urllib.parse import urlsplit

from harbor.agents.factory import AgentFactory
from harbor.agents.installed.pi import Pi
from harbor.environments.factory import EnvironmentFactory
from harbor.job_plan import JobPlan
from harbor.models.agent.acp_source import AcpAgentSource
from harbor.models.job.config import DatasetConfig, JobConfig
from harbor.models.metric.type import MetricType
from harbor.models.task.task import Task
from harbor.models.trial.config import AgentConfig, TaskConfig
from harbor.registry.client.factory import RegistryClientFactory
from harbor.registry.client.git_repo import resolve_repo_source
from harbor.registry.client.package import PackageDatasetClient
from pydantic import ValidationError

REVISION = "dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e"
COMMIT = re.compile(r"[0-9a-f]{40}")
CONTENT = re.compile(r"sha256:[0-9a-f]{64}")


def record(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError("Expected an object")
    return cast(dict[str, object], value)


def check_revision() -> None:
    data = importlib.metadata.distribution("harbor").read_text("direct_url.json")
    if not data or json.loads(data).get("vcs_info", {}).get("commit_id") != REVISION:
        raise ValueError("Installed Harbor revision does not match the launch contract")


def catalog(root: Path) -> dict[str, object]:
    entries: list[dict[str, object]] = []
    seen: set[str] = set()
    for path in sorted((root / "agents").glob("*.json")):
        preset = record(json.loads(path.read_text()))
        fragment = record(preset["harbor_agent"])
        config = AgentConfig.model_validate(fragment)
        identity = config.import_path or config.name or ""
        if identity in seen:
            continue
        seen.add(identity)
        cls = AgentFactory.get_agent_class_from_config(config)
        entries.append(
            {
                "label": f"{preset['agent']} ({preset['version']})",
                "config": {
                    **fragment,
                    "model_name": "huggingface/" if issubclass(cls, Pi) else "openai/",
                },
                "options_schema": cls.options_schema() if cls.options_model else {},
            }
        )
    config = AgentConfig(name="acp")
    cls = AgentFactory.get_agent_class_from_config(config)
    entries.append(
        {
            "label": "acp",
            "config": {"name": "acp", "model_name": "openai/"},
            "options_schema": cls.options_schema(),
        }
    )
    return {
        "harbor_revision": REVISION,
        "agents": entries,
        "job_schema": JobConfig.model_json_schema(),
    }


def relative_path(value: object) -> None:
    path = str(value)
    if (
        PurePosixPath(path).is_absolute()
        or ".." in PurePosixPath(path).parts
        or "\\" in path
        or path.startswith("~")
    ):
        raise ValueError("Source paths must stay inside the repository")


def public_git(value: str) -> None:
    url = urlsplit(value)
    if (
        url.scheme != "https"
        or url.hostname != "github.com"
        or url.username
        or url.password
        or url.port
        or url.query
        or url.fragment
    ):
        raise ValueError("Sources must use credential-free public GitHub HTTPS URLs")


def check_dataset(source: DatasetConfig) -> None:
    if source.repo:
        # Harbor owns repository syntax; admission restricts its parsed result.
        repo = resolve_repo_source(source.repo)
        public_git(repo.git_url)
        if not repo.ref or not COMMIT.fullmatch(repo.ref):
            raise ValueError("Git datasets require a full immutable commit")
        relative_path(source.path if source.path is not None else repo.subdir or ".")
    elif source.is_package():
        if not source.ref or not CONTENT.fullmatch(source.ref):
            raise ValueError("Package datasets require an immutable sha256 ref")
    else:
        raise ValueError("Use a package dataset or a pinned public Git dataset")
    if source.registry_url or source.registry_path or source.download_dir:
        raise ValueError("Registry overrides and local download paths are not admitted")


def check_task(task: TaskConfig) -> None:
    if task.git_url:
        public_git(task.git_url)
        if not task.git_commit_id or not COMMIT.fullmatch(task.git_commit_id):
            raise ValueError("Git tasks require a full immutable commit")
        relative_path(task.path)
    elif task.is_package_task():
        if not task.ref or not CONTENT.fullmatch(task.ref):
            raise ValueError("Package tasks require an immutable sha256 ref")
    else:
        raise ValueError("Local tasks are not admitted")
    if task.download_dir:
        raise ValueError("Local task download paths are not admitted")


def check_sources(config: JobConfig) -> None:
    for source in config.datasets:
        check_dataset(source)
    for task in config.tasks:
        check_task(task)


def check_agents(
    config: JobConfig, available: dict[str, object], approved: list[object]
) -> None:
    entries = cast(list[dict[str, object]], available["agents"])
    identities = [record(entry["config"]) for entry in entries]
    for agent in config.agents:
        matching = [
            item
            for item in identities
            if agent.import_path == item.get("import_path")
            and agent.name == item.get("name")
        ]
        if not matching:
            raise ValueError(
                "Agent implementation is not in the reviewed installed catalog"
            )
        if not agent.model_name or not agent.model_name.startswith(
            str(matching[0]["model_name"])
        ):
            raise ValueError(
                "Model route does not match the reviewed native agent template"
            )
        if agent.skills or agent.load_trajectory:
            raise ValueError("Skills and trajectory loading are not admitted")
        if any(
            key in agent.kwargs
            for key in ("prompt_template_path", "config", "config_path")
        ):
            raise ValueError(
                "Agent file and configuration overrides require a reviewed integration"
            )
        check_agent_options(agent, identities, approved)


def check_agent_options(
    agent: AgentConfig, identities: list[dict[str, object]], approved: list[object]
) -> None:
    cls = AgentFactory.get_agent_class_from_config(agent)
    if cls.options_model is None:
        if not any(
            agent.kwargs == item.get("kwargs", {})
            for item in identities
            if agent.import_path == item.get("import_path")
            and agent.name == item.get("name")
        ):
            raise ValueError(
                "This agent has no native option schema; use its preset options"
            )
        return
    cls.parse_options(agent.kwargs, agent.env)
    if agent.name == "acp":
        check_acp_source(agent.kwargs.get("source"), approved)
    elif "version" in cls.options_schema().get("properties", {}):
        version = agent.kwargs.get("version")
        if (
            not isinstance(version, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.+_-]{0,159}", version)
            or version in ("latest", "main", "master", "HEAD")
        ):
            raise ValueError("Choose an exact reviewed agent CLI version")


def check_acp_source(source: object, approved: list[object]) -> None:
    if source is None:
        raise ValueError("ACP source must match an operator-approved immutable source")
    candidate = AcpAgentSource.model_validate(source)
    if candidate not in [AcpAgentSource.model_validate(item) for item in approved]:
        raise ValueError("ACP source must match an operator-approved immutable source")
    public_git(candidate.repo_url)
    if not COMMIT.fullmatch(candidate.ref):
        raise ValueError("ACP source requires a full immutable commit")


async def check_metrics(config: JobConfig) -> None:
    # Dataset metrics execute in the parent. Inspect metadata BEFORE JobPlan can
    # download metric scripts or construct any metric extension.
    if config.metrics:
        raise ValueError("Custom job metrics are not admitted")
    for source in config.datasets:
        if source.repo:
            client = RegistryClientFactory.create(repo=source.repo, path=source.path)
            name = (
                f"{source.name}@{source.version}"
                if source.version
                else source.name or ""
            )
        else:
            client = PackageDatasetClient()
            name = f"{source.name}@{source.ref}"
        metadata = await client.get_dataset_metadata(name)
        if metadata.files or any(
            metric.type == MetricType.UV_SCRIPT for metric in metadata.metrics
        ):
            raise ValueError(
                "Dataset executable metrics and attached files require separate review"
            )


async def inspect(
    config_value: object, root: Path, approved: list[object]
) -> dict[str, object]:
    config = JobConfig.model_validate(config_value)
    # Harbor permits an empty agent list and nonpositive attempts. Hosted
    # diagnostic submissions need at least one scored trial. Harbor already
    # validates concurrency and retry minima; do not repeat those rules here.
    if not config.agents or config.n_attempts < 1:
        raise ValueError("Diagnostic jobs require at least one agent and attempt")
    check_sources(config)
    check_agents(config, catalog(root), approved)
    await check_metrics(config)
    tasks = await JobPlan.resolve_task_configs(config)
    for task_config in tasks:
        check_task(task_config)
    # Native planning eagerly materializes every TrialConfig and trial lock.
    # Bound that work before downloads and plan allocation in the control Space;
    # do not impose separate caps on sources, agents, attempts, or concurrency.
    if len(tasks) * len(config.agents) * config.n_attempts > 10000:
        raise ValueError("The resolved plan exceeds the 10,000-trial inspection budget")
    EnvironmentFactory.validate_resource_policies(config.environment)
    plan = JobPlan.from_resolved(
        config,
        task_configs=tasks,
        metrics=await JobPlan.resolve_metrics(config, tasks),
        task_download_results=await JobPlan.cache_tasks(tasks),
    )
    for download in plan.task_download_results.values():
        task = Task(download.path, disable_verification=config.verifier.disable)
        if not task.config.environment.docker_image:
            raise ValueError("Every HF Sandbox task requires a prebuilt Docker image")
    return {
        "harbor_revision": REVISION,
        "tasks": len(plan.task_configs),
        "agents": len(config.agents),
        "trials": len(plan.trial_configs),
        "warnings": [
            "Post-trial cost stops do not cap in-flight inference "
            "or HF infrastructure charges."
        ],
        "not_performed": [
            "Agent installation",
            "Custom source execution",
            "Container registry access",
            "HF Sandbox startup",
            "Model inference",
            "Cost and ETA estimation",
        ],
    }


def failure_response(exc: Exception) -> dict[str, object]:
    validation = exc if isinstance(exc, ValidationError) else exc.__cause__
    if isinstance(validation, ValidationError):
        errors = validation.errors(
            include_input=False, include_url=False, include_context=False
        )
        detail = "; ".join(
            f"{'.'.join(map(str, error['loc']))}: {error['msg']}" for error in errors
        )
        return {
            "error": f"Invalid native configuration: {detail}"[:2000],
            "invalid": True,
        }
    return {
        "error": str(exc)[:2000]
        if type(exc) is ValueError
        else "Native Harbor inspection failed",
        "invalid": type(exc) is ValueError,
    }


def main() -> None:
    try:
        check_revision()
        request = record(json.loads(sys.stdin.read(1_048_577)))
        root = Path(sys.argv[1])
        # Keep native progress messages out of the machine-readable response.
        with contextlib.redirect_stdout(sys.stderr):
            if request.get("operation") == "catalog":
                result = catalog(root)
            elif request.get("operation") == "validate":
                result = asyncio.run(
                    inspect(
                        request["config"],
                        root,
                        cast(list[object], request.get("approved_sources", [])),
                    )
                )
            else:
                raise ValueError("Unknown launch inspection operation")
        print(json.dumps(result))
    except Exception as exc:
        # Native exceptions can include user input or URLs. The control service
        # does not publish arbitrary stderr or traceback text.
        print(json.dumps(failure_response(exc)))
        sys.exit(1)


if __name__ == "__main__":
    main()
