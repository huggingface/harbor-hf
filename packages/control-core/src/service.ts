import type { RunStateV1 } from "@harbor-hf/contracts";
import type { RunRecordV1 } from "@harbor-hf/contracts";
import type {
  HarborAgentFragment,
  PresetCatalog,
  PresetSubmission,
} from "./presets.js";
import type { JobsPort } from "./jobs.js";
import type { Projection } from "./projection.js";
import type { ObjectStore } from "./store.js";

export const EXECUTION_DISABLED_REASON =
  "Execution is disabled: a supported Harbor runner and isolated credential boundary are not yet available. Configuration and preview do not launch Jobs.";
export class ExecutionDisabledError extends Error {
  constructor() {
    super(EXECUTION_DISABLED_REASON);
  }
}
export function rejectExecution(): never {
  throw new ExecutionDisabledError();
}

export interface ControlServiceOptions {
  harborRevision: string;
  mountRoot: string;
  maxActiveJobs: number;
  restartDelayMs: number;
}

export interface SubmissionResult {
  created: boolean;
  run: RunRecordV1;
}

export class ControlService {
  constructor(
    readonly store: ObjectStore,
    readonly projection: Projection,
    readonly presets: PresetCatalog,
    readonly jobs: JobsPort,
    readonly options: ControlServiceOptions,
  ) {}
  async initialize(): Promise<void> {
    await this.refresh();
  }
  async refresh(): Promise<void> {
    await this.projection.rebuild(this.store, await this.jobs.list());
  }
  async submitPreset(
    _input: PresetSubmission,
    _key: string,
    _actor: string,
  ): Promise<SubmissionResult> {
    return rejectExecution();
  }
  async submitWorkbench(
    _input: PresetSubmission,
    _agent: HarborAgentFragment,
    _key: string,
    _actor: string,
  ): Promise<SubmissionResult> {
    return rejectExecution();
  }
  async submitConfig(
    _input: unknown,
    _ceiling: number,
    _key: string,
    _actor: string,
  ): Promise<SubmissionResult> {
    return rejectExecution();
  }
  async setDesiredState(
    _id: string,
    _desired: "run" | "paused" | "cancelled",
    _actor: string,
  ): Promise<RunStateV1> {
    return rejectExecution();
  }
  async reconcile(): Promise<void> {
    return rejectExecution();
  }
}

export class Reconciler {
  constructor(
    private readonly service: ControlService,
    private readonly intervalMs: number,
  ) {}
  start(_onError?: (error: unknown) => void): void {
    void this.service;
    void this.intervalMs;
    rejectExecution();
  }
  async stop(): Promise<void> {}
}
