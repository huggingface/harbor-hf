import { randomUUID } from "node:crypto";
import type { OperatorAcl } from "@harbor-hf/contracts";
import {
  ControlService,
  FilesystemObjectStore,
  InferenceRegistry,
  prohibitedInferenceName,
  InferenceBindingDenied,
  type ObjectStore,
  PresetCatalog,
  Projection,
  Reconciler,
} from "@harbor-hf/control-core";
import {
  HuggingFaceBucketStore,
  HuggingFaceJobs,
  HuggingFaceWorkbenchJobs,
  NoopJobs,
  ReadOnlyHuggingFaceJobs,
} from "@harbor-hf/hf-adapters";
import { AuthenticationService, AuthStore } from "./auth.js";
import type { AppConfig } from "./config.js";
import { HARBOR_REVISION } from "./harbor-revision.js";
import { type LaunchPort, NativeLaunch } from "./launch.js";
import { WorkbenchRuntime } from "./workbench.js";

export interface Runtime {
  config: AppConfig;
  projection: Projection;
  store: ObjectStore;
  service: ControlService;
  inference: InferenceRegistry;
  auth: AuthenticationService;
  reconciler: Reconciler;
  presets: PresetCatalog;
  workbench: WorkbenchRuntime;
  launch: LaunchPort;
  readonly ready: boolean;
  initialize(): Promise<void>;
  start(onReconcilerError?: (error: unknown) => void): void;
  close(): Promise<void>;
}

/** Read exactly one validated own key; never enumerate or inherit environment values. */
export function readOwnInferenceSource(
  environment: Readonly<Record<string, unknown>>,
  source: string,
): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(source) || prohibitedInferenceName(source))
    throw new InferenceBindingDenied();
  if (!Object.hasOwn(environment, source)) return undefined;
  const value = environment[source];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function createRuntime(
  config: AppConfig,
  readSelectedSource: (source: string) => string | undefined = (source) =>
    readOwnInferenceSource(process.env, source),
): Promise<Runtime> {
  if (config.store_mode === "bucket" && !config.hf_token)
    throw new Error("Bucket mode requires the control credential");
  const store: ObjectStore =
    config.store_mode === "bucket"
      ? new HuggingFaceBucketStore({
          bucketId: config.bucket_id,
          accessToken: config.hf_token ?? "",
        })
      : new FilesystemObjectStore(config.bucket_root);
  const projection = await Projection.open(config.projection_path);
  const presets = await PresetCatalog.load(config.presets_root);
  const jobs =
    config.store_mode === "filesystem"
      ? new NoopJobs()
      : config.write_mode === "enabled"
        ? new HuggingFaceJobs({
            namespace: config.namespace,
            accessToken: config.hf_token ?? "",
            inferenceToken: config.hf_inference_token ?? "",
            bucketId: config.bucket_id,
            parentImage: config.parent_image ?? "",
            hardware: config.parent_hardware,
            timeoutSeconds: config.parent_timeout_seconds,
          })
        : new ReadOnlyHuggingFaceJobs({
            namespace: config.namespace,
            accessToken: config.hf_token ?? "",
          });
  // Read only the selected name. Compare infrastructure authority values in memory
  // so an ordinary alias cannot launder the control or OAuth credential.
  const selectedSource = (source: string) => {
    let value: unknown;
    try {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(source) ||
        prohibitedInferenceName(source)
      )
        throw new InferenceBindingDenied();
      value = readSelectedSource(source);
    } catch {
      throw new InferenceBindingDenied("Inference credential presence is unavailable");
    }
    if (typeof value !== "string" || value.length === 0) return undefined;
    if (
      value &&
      [config.hf_token, config.hf_inference_token, config.oauth?.client_secret].some(
        (authority) => authority && authority === value,
      )
    )
      throw new InferenceBindingDenied();
    return value;
  };
  const inference = new InferenceRegistry(
    store,
    config.parent_image ?? "",
    (source) => Boolean(selectedSource(source)),
    () => new Date(),
    randomUUID,
  );
  const admittedPolicy = () => inference.policy();
  const service = new ControlService(store, projection, presets, jobs, {
    inference: {
      policy: admittedPolicy,
      sequence: (operation) => inference.sequence(operation),
      image: config.parent_image ?? "",
      present: (source) => Boolean(selectedSource(source)),
      start: (run) => {
        if (!(jobs instanceof HuggingFaceJobs))
          throw new Error("Job launch is disabled");
        return jobs.startReviewedParent(run, admittedPolicy, selectedSource);
      },
    },
    harborRevision: HARBOR_REVISION,
    mountRoot: "/data",
    maxActiveJobs: config.max_active_jobs,
    restartDelayMs: config.parent_restart_delay_ms,
  });
  const acl: OperatorAcl = {
    schema_version: "v1",
    kind: "operator.acl",
    record_id: "bootstrap-operator-acl",
    created_at: "1970-01-01T00:00:00.000Z",
    actor: { subject: "harbor-hf-bootstrap", role: "service" },
    operators: [...new Set(config.bootstrap_operator_subjects)].sort(),
    readers: [],
  };
  const authStore = await AuthStore.open(config.auth_path);
  const auth = new AuthenticationService(
    config.auth_mode,
    authStore,
    config.oauth,
    async () => acl,
  );
  const reconciler = new Reconciler(service, config.reconcile_interval_ms);
  const remoteWorkbenchJobs =
    config.workbench_runner === "hf-jobs"
      ? new HuggingFaceWorkbenchJobs({
          namespace: config.namespace,
          accessToken: config.hf_token ?? "",
          image: config.workbench_image,
          maxActiveJobs: config.max_active_jobs,
        })
      : null;
  if (config.workbench_runner === "hf-jobs" && !config.hf_token)
    throw new Error("hosted Workbench requires the control credential");
  const workbench = new WorkbenchRuntime(
    config.workbench_runner,
    config.workbench_image,
    remoteWorkbenchJobs,
  );
  let ready = false;
  return {
    config,
    projection,
    store,
    service,
    inference,
    auth,
    reconciler,
    presets,
    workbench,
    launch: new NativeLaunch(config),
    get ready() {
      return ready;
    },
    async initialize() {
      ready = false;
      await auth.initialize();
      await service.initialize();
      ready = true;
    },
    start(onReconcilerError?: (error: unknown) => void) {
      if (!ready) throw new Error("Runtime is not initialized");
      if (config.write_mode === "enabled") reconciler.start(onReconcilerError);
    },
    async close() {
      ready = false;
      await reconciler.stop();
      await workbench.close();
      authStore.close();
      projection.close();
    },
  };
}
