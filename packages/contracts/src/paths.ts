const RUN_ID = /^run-[0-9a-f]{24}$/;

export function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error("invalid run id");
}

export function runRoot(runId: string): string {
  assertRunId(runId);
  return `runs/${runId}`;
}

export function runRecordPath(runId: string): string {
  return `${runRoot(runId)}/run.json`;
}

export function runStatePath(runId: string): string {
  return `${runRoot(runId)}/state.json`;
}

export function harborJobRoot(runId: string): string {
  return `${runRoot(runId)}/job`;
}

export function harborJobResultPath(runId: string): string {
  return `${harborJobRoot(runId)}/result.json`;
}
