"""Operator-reviewed one-for-one replacements; native Harbor owns aggregation.

Authority boundary
------------------
These Python operations are an internal trusted-storage interface, NOT browser
admission. The control ObjectStore or parent SDK loads immutable run records and
native config/lock/result/trial evidence. Evidence.parse compares native models
with the original RunRecord and checks complete native coverage. That existing
admission is authority for the exact agent/model/recipe: derive preserves every
component, validate_child rejects any component change, and fingerprints bind the
whole source evidence. No new component is admitted here. Native AgentConfig,
AgentFactory resolution and option/source policy still apply; the unrelated fresh
configuration catalog does not. Direct validate/check_agents, normal execution
review and inference-binding authorization are unchanged.

Internal payload (both replacement_review and replacement_aggregate)
------------------------------------------------------------------
original_ancestors?: [{record, config, lock, result, trials}, ...]

Each optional array member has the same evidence shape as original. Order is
irrelevant; supply exactly the ancestors of original, excluding original itself,
until the root without operator_selection. Omission means an empty array, not a
provenance bypass. Missing, duplicate, foreign, unused and cyclic bundles fail.
Never load these bundles from browser-authored data. The field is ephemeral: no
RunRecord/schema fields, source_jobs, source_trial or regrade authority are added.

The parent uses the same ancestry/validate_ancestry checks with an SDK loader.
Every link passes validate_child before any private source tuple is inherited.
Only check_sources(root.config) grants tuples; native planning and check_task
validate every source generation. Native resolve_metrics receives the root's
original dataset config, without copying metric declarations into descendants.

Aggregation is view-only, never reconciliation/completion evidence. It returns a
full native JobResult without rewriting native IDs. started_at belongs to
original; finished_at/updated_at are the maximum actual constituent job finish,
including replaced-away jobs, never the aggregation wall clock.

Checked Harbor dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e: job_plan.py
(resolve_task_configs, build_trial_configs, resolve_metrics, aggregate),
models/job/{config,lock,result}.py, models/trial/{config,result}.py and
agents/factory.py (get_agent_class_from_config); option-discovery history includes
ac476798. Native source_jobs selects regrade, not replacement provenance. This
only repairs the separately approved storage-neutral replacement bridge; remove
it when a reviewed Harbor pin provides equivalent provenance/coverage authority.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from pathlib import Path
from uuid import UUID

from harbor.job_plan import JobPlan
from harbor.models.job.result import JobResult
from harbor.models.trial.config import TaskConfig
from harbor.models.trial.result import TrialResult

from harbor_hf_agents import launch
from harbor_hf_agents.replacement_evidence import (
    Evidence,
    canonical,
    cohort_key,
    derive,
    lock_matches,
    native,
    objects,
    owned_config,
)


def ancestry(source: Evidence, load: Callable[[str], Evidence]) -> list[Evidence]:
    """Resolve trusted evidence only; validate every derivation before inheritance."""
    chain = [source]
    seen = {source.run_id}
    while "operator_selection" in chain[-1].record:
        selection = launch.record(chain[-1].record["operator_selection"])
        run_id = str(selection["original_run_id"])
        if run_id in seen:
            raise ValueError("Cyclic replacement source provenance")
        seen.add(run_id)
        parent = load(run_id)
        if parent.run_id != run_id:
            raise ValueError("Foreign replacement ancestor evidence")
        chain.append(parent)
    chain.reverse()
    for parent, child in zip(chain, chain[1:], strict=False):
        validate_child(parent, child)
    return chain


def request_ancestry(source: Evidence, value: object) -> list[Evidence]:
    bundles = [Evidence.parse(item) for item in objects(value)]
    indexed = {item.run_id: item for item in bundles}
    if len(indexed) != len(bundles):
        raise ValueError("Duplicate replacement ancestor evidence")

    def load(run_id: str) -> Evidence:
        if run_id not in indexed:
            raise ValueError("Missing replacement ancestor evidence")
        return indexed.pop(run_id)

    chain = ancestry(source, load)
    if indexed:
        raise ValueError("Unused replacement ancestor evidence")
    return chain


async def validate_ancestry(
    chain: list[Evidence],
) -> tuple[launch.PrivateDatasetSources, list[TaskConfig]]:
    private = launch.check_sources(chain[0].config)
    tasks: list[TaskConfig] = []
    for source in chain:
        tasks = await validate_tasks(source, private)
    return private, tasks


async def admit(
    source: Evidence,
    approved: list[object],
    root: Path,
    chain: list[Evidence] | None = None,
) -> tuple[launch.PrivateDatasetSources, list[TaskConfig]]:
    # Evidence is loaded by trusted storage, never accepted from a browser.
    # Its exact native components were already admitted. Resolve the factory and
    # validate native options, but do not apply the unrelated direct-config menu.
    for agent in source.config.agents:
        launch.check_agent_options(agent, [native(agent)], approved)
    chain = chain if chain is not None else request_ancestry(source, [])
    admitted = await validate_ancestry(chain)
    await launch.check_metrics(chain[0].config)
    return admitted


async def validate_tasks(
    source: Evidence, private: launch.PrivateDatasetSources
) -> list[TaskConfig]:
    tasks = await JobPlan.resolve_task_configs(source.config)
    for task in tasks:
        launch.check_task(task, private)
    expected = Counter(canonical(native(task)) for task in tasks)
    expected = Counter(
        {key: count * source.config.n_attempts for key, count in expected.items()}
    )
    actual = Counter(canonical(native(t.config.task)) for t in source.trials)
    if expected != actual:
        raise ValueError(
            "Native configured task multiplicity does not cover source trials"
        )
    return tasks


async def review(request: dict[str, object], root: Path) -> dict[str, object]:
    source = Evidence.parse(request["original"])
    selected = source.select(request["trial_ids"])
    approved = objects(request.get("approved_sources", []))
    chain = request_ancestry(source, request.get("original_ancestors", []))
    private, _ = await admit(source, approved, root, chain)
    config = derive(
        source, selected, str(request["run_id"]), Path(str(request["local_root"]))
    )
    summary = await launch.inspect_plan(config, private)
    return {
        **summary,
        "effective_config": native(config),
        "fingerprint": source.fingerprint(selected),
    }


def validate_child(source: Evidence, child: Evidence) -> list[TrialResult]:
    if source.result.id == child.result.id:
        raise ValueError("Replacement must have a distinct native job UUID")
    selection = launch.record(child.record.get("operator_selection"))
    if selection.get("original_run_id") != source.run_id:
        raise ValueError(
            "Replacement hierarchy references a different native source run"
        )
    selected = source.select(selection.get("trial_ids"))
    if selection.get("source_fingerprint") != source.fingerprint(selected):
        raise ValueError("Replacement source fingerprint mismatch")
    expected = derive(source, selected, child.run_id, Path("/data"))
    if owned_config(child.config) != owned_config(expected):
        raise ValueError("Replacement configuration differs from approved derivation")
    if Counter(map(cohort_key, selected)) != Counter(map(cohort_key, child.trials)):
        raise ValueError("Replacement task/checksum/config multiplicity mismatch")
    expected_locks = Counter(lock_key(source, t) for t in selected)
    if expected_locks != Counter(lock_key(child, t) for t in child.trials):
        raise ValueError("Replacement native task lock digest/config mismatch")
    return selected


def lock_key(source: Evidence, trial: TrialResult) -> str:
    matches = [item for item in source.lock.trials if lock_matches(item, trial)]
    values = []
    for item in matches:
        value = native(item)
        launch.record(launch.record(value["environment"])["kwargs"]).pop(
            "run_label", None
        )
        values.append(canonical(value))
    if len(set(values)) != 1:
        raise ValueError("Ambiguous native task lock evidence")
    return values[0]


def assemble(
    source: Evidence,
    parts: object,
    seen_runs: set[str],
    seen_ids: set[UUID],
    jobs: list[JobResult] | None = None,
) -> list[TrialResult]:
    ids = [source.result.id, *(t.id for t in source.trials)]
    if (
        source.run_id in seen_runs
        or seen_ids.intersection(ids)
        or len(set(ids)) != len(ids)
    ):
        raise ValueError("Reused source run or native trial UUID")
    if jobs is not None:
        jobs.append(source.result)
    seen_runs.add(source.run_id)
    seen_ids.update(ids)
    removed: set[UUID] = set()
    additions: list[TrialResult] = []
    for value in objects(parts):
        part = launch.record(value)
        child = Evidence.parse(part["evidence"])
        selected = validate_child(source, child)
        ids = {t.id for t in selected}
        if removed.intersection(ids):
            raise ValueError("Duplicate or reused replacement targets")
        removed.update(ids)
        additions.extend(assemble(child, part["parts"], seen_runs, seen_ids, jobs))
    results = [t for t in source.trials if t.id not in removed] + additions
    if Counter(map(cohort_key, results)) != Counter(map(cohort_key, source.trials)):
        raise ValueError("Assembled native cohort multiplicity mismatch")
    return results


async def aggregate(request: dict[str, object], root: Path) -> dict[str, object]:
    source = Evidence.parse(request["original"])
    jobs: list[JobResult] = []
    results = assemble(source, request["parts"], set(), set(), jobs)
    chain = request_ancestry(source, request.get("original_ancestors", []))
    _, tasks = await admit(
        source, objects(request.get("approved_sources", [])), root, chain
    )
    # No from_resolved: building locks requires actual task files. The public
    # constructor needs none for aggregation. Original datasets own the metrics.
    plan = JobPlan(
        config=source.config,
        id=source.result.id,
        task_configs=tasks,
        trial_configs=[t.config for t in source.trials],
        job_lock=source.lock,
        task_download_results={},
        metrics=await JobPlan.resolve_metrics(chain[0].config, tasks),
    )
    finished_at = max(job.finished_at for job in jobs if job.finished_at is not None)
    result = plan.aggregate(
        results,
        started_at=source.result.started_at,
        finished_at=finished_at,
        updated_at=finished_at,
    )
    return {"result": result.model_dump(mode="json")}
