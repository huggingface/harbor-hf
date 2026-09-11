"""Revision-scoped native scrub ordering; not an additional sanitizer.

Reviewed Harbor trial/trial.py, trial/hooks.py, trial/queue.py and job.py at
SCRUB_REVISION (scrubbing introduced in 046e2a6d). Replace this integration at
the first reviewed pin with a supported post-sanitization hook or pre-END scrub.

Use one context around Job creation, execution, and final file uploads in an
otherwise exclusive parent process. All trial tasks must finish before exit.
Check ``failed`` before final full-tree uploads, including in exception paths.
Unexpected job/finalization errors must propagate out of the context. Only
known cost/control stops with completed native cleanup permit a final copy.
Never serialize hook event.result: Harbor scrubs files, not in-memory results.
Native aggregation and job-level logs are not sanitized by this adapter. Native
scrubbing also deliberately skips some files/errors; this is no stronger promise.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from threading import Lock

from harbor.trial.hooks import TrialEvent
from harbor.trial.trial import Trial

from harbor_hf_agents import launch

SCRUB_REVISION = "dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e"
_NATIVE_EMIT = Trial._emit
_PATCH_LOCK = Lock()


@dataclass
class ScrubBeforeUpload:
    """Sticky local upload veto, not persisted Harbor execution state.

    A scrub failure vetoes final uploads even if caught inside the context.
    Unexpected callback errors must propagate out of the context.
    The caller must not clear this flag or treat false as a whole-tree guarantee.
    """

    failed: bool = False


async def _scrub_and_emit(
    state: ScrubBeforeUpload, trial: Trial, event: TrialEvent
) -> None:
    if event != TrialEvent.END:
        await _NATIVE_EMIT(trial, event)
        return
    try:
        if state.failed:
            raise RuntimeError("Harbor scrub integration has failed; uploads blocked")
        trial._scrub_jobs_dir()
    except BaseException:
        state.failed = True
        raise
    await _NATIVE_EMIT(trial, event)


@contextmanager
def scrub_before_upload() -> Iterator[ScrubBeforeUpload]:
    """Scrub the actual trial before native END dispatch; retain native finally.

    Reject overlapping contexts and foreign method bindings. A body exception
    also vetoes uploads, but is never suppressed. Restoration is unconditional.
    """
    if launch.REVISION != SCRUB_REVISION:
        raise ValueError("Harbor scrub integration revision does not match launch")
    launch.check_revision()
    if not _PATCH_LOCK.acquire(blocking=False):
        raise RuntimeError("Harbor scrub integration is already active")

    state = ScrubBeforeUpload()

    async def emit(self: Trial, event: TrialEvent) -> None:
        await _scrub_and_emit(state, self, event)

    try:
        if Trial._emit is not _NATIVE_EMIT:
            raise RuntimeError("Unexpected Harbor Trial._emit binding")
        Trial._emit = emit
        try:
            yield state
        except BaseException:
            state.failed = True
            raise
        finally:
            rebound = Trial._emit is not emit
            Trial._emit = _NATIVE_EMIT
            if rebound:
                state.failed = True
                raise RuntimeError(
                    "Harbor Trial._emit rebound during scrub integration"
                )
    finally:
        _PATCH_LOCK.release()
