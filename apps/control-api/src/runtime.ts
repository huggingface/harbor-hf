import type { OperatorAcl } from "@harbor-hf/contracts";
import {
  ControlService,
  FilesystemObjectStore,
  type ObjectStore,
  PresetCatalog,
  Projection,
  Reconciler,
} from "@harbor-hf/control-core";
import {
  HuggingFaceBucketStore,
  HuggingFaceJobs,
  NoopJobs,
} from "@harbor-hf/hf-adapters";
import { AuthenticationService, AuthStore } from "./auth.js";
import type { AppConfig } from "./config.js";
import { LocalHarborRuntime } from "./local-harbor.js";
import { WorkbenchRuntime } from "./workbench.js";

const HARBOR_REVISION = "dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e";

export interface Runtime {
  config: AppConfig;
  projection: Projection;
  store: ObjectStore;
  service: ControlService;
  auth: AuthenticationService;
  reconciler: Reconciler;
  presets: PresetCatalog;
  readonly ready: boolean;
  initialize(): Promise<void>;
  start(onReconcilerError?: (error: unknown) => void): void;
  close(): Promise<void>;
}

export async function createRuntime(config: AppConfig): Promise<Runtime> {
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
    config.write_mode === "enabled"
      ? new HuggingFaceJobs({
          namespace: config.namespace,
          accessToken: config.hf_token ?? "",
          inferenceToken: config.hf_inference_token ?? "",
          bucketId: config.bucket_id,
          parentImage: config.parent_image ?? "",
          hardware: config.parent_hardware,
          timeoutSeconds: config.parent_timeout_seconds,
        })
      : new NoopJobs();
  const service = new ControlService(store, projection, presets, jobs, {
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
  let ready = false;
  return {
    config,
    projection,
    store,
    service,
    auth,
    reconciler,
    presets,
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
      if (config.write_mode === "enabled") reconciler.start(onReconcilerError);
    },
    async close() {
      ready = false;
      await reconciler.stop();
      await workbench.close();
      await localHarbor.close();
      authStore.close();
      projection.close();
    },
  };
}
