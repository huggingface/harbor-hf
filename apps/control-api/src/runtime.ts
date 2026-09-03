import { existsSync } from "node:fs";
import type { OperatorAcl } from "@harbor-hf/contracts";
import { deterministicId, sha256 } from "@harbor-hf/contracts";
import {
  ControlService,
  FilesystemObjectStore,
  type ImmutableObjectStore,
  loadBuiltInProfiles,
  Projection,
  Reconciler,
  ResultPublisher,
} from "@harbor-hf/control-core";
import {
  attestInferenceToken,
  HuggingFaceActions,
  HuggingFaceBucketStore,
  HuggingFaceWorkbenchJobs,
  NoopActions,
} from "@harbor-hf/hf-adapters";
import { AuthenticationService, AuthStore } from "./auth.js";
import type { AppConfig } from "./config.js";
import { LocalHarborRuntime } from "./local-harbor.js";
import { WorkbenchRuntime } from "./workbench.js";

export interface Runtime {
  config: AppConfig;
  projection: Projection;
  store: ImmutableObjectStore;
  service: ControlService;
  auth: AuthenticationService;
  reconciler: Reconciler;
  workbench: WorkbenchRuntime;
  localHarbor: LocalHarborRuntime;
  readonly ready: boolean;
  initialize(): Promise<void>;
  start(onReconcilerError?: (error: unknown) => void): void;
  close(): Promise<void>;
}

export async function createRuntime(config: AppConfig): Promise<Runtime> {
  if (config.store_mode === "filesystem" && !existsSync(config.bucket_root))
    throw new Error("filesystem object-store root is missing");
  const store: ImmutableObjectStore =
    config.store_mode === "bucket"
      ? new HuggingFaceBucketStore({
          bucketId: config.bucket_id,
          accessToken: config.hf_token ?? "",
        })
      : new FilesystemObjectStore(config.bucket_root);
  const projection = await Projection.open(config.projection_path);
  const profiles = await loadBuiltInProfiles(config.profiles_root);
  const service = new ControlService(config.namespace, store, projection, profiles);
  service.configureCapacityProfile(config.capacity_profile_alias);
  const authStore = await AuthStore.open(config.auth_path);
  const auth = new AuthenticationService(
    config.auth_mode,
    authStore,
    config.oauth,
    () => projection.latestAcl(),
  );
  const hfActions = config.hf_token
    ? new HuggingFaceActions({
        namespace: config.namespace,
        accessToken: config.hf_token,
        taskImageMirrorRepository: config.task_image_mirror_repository,
        ...(config.hf_inference_token
          ? { inferenceToken: config.hf_inference_token }
          : {}),
        controlUrl: config.public_origin,
      })
    : null;
  const external = hfActions ?? new NoopActions();
  const publisher = new ResultPublisher(store, projection, service);
  const workbenchJobs =
    config.workbench_runner === "hf-jobs" && config.hf_token
      ? new HuggingFaceWorkbenchJobs({
          namespace: config.namespace,
          accessToken: config.hf_token,
          image: config.workbench_image,
          maxActiveJobs: config.max_active_jobs,
        })
      : null;
  const workbench = new WorkbenchRuntime(
    config.workbench_runner,
    config.workbench_image,
    workbenchJobs,
  );
  service.configureWorkbenchSetupAttestor((setupTestId, owner, recipe) =>
    workbench.attestPassedSetup(setupTestId, owner, recipe),
  );
  const localHarbor = new LocalHarborRuntime(
    config.node_env === "development" && config.auth_mode === "development",
    config.hf_inference_token,
    config.profiles_root,
    profiles,
  );
  const reconciler = new Reconciler(service, projection, external, publisher, {
    interval_ms: config.reconcile_interval_ms,
    sync_interval_ms: config.sync_interval_ms,
    observation_interval_ms: config.observe_interval_ms,
    worker_receipt_grace_ms: config.worker_receipt_grace_ms,
    batch_size: 16,
  });
  const abort = new AbortController();
  let initializationReady = false;
  return {
    config,
    projection,
    store,
    service,
    auth,
    reconciler,
    workbench,
    localHarbor,
    get ready() {
      return initializationReady && projection.system().ready;
    },
    async initialize() {
      initializationReady = false;
      if (
        config.hf_inference_token &&
        !(config.node_env === "development" && config.auth_mode === "development")
      )
        await attestInferenceToken({ accessToken: config.hf_inference_token });
      await auth.initialize();
      await projection.rebuild(store);
      await service.initialize(profiles);
      if (config.write_mode !== "disabled") {
        if (!service.capacityProfileOrNull())
          await service.setMaxActiveJobs(
            config.max_active_jobs,
            `capacity-bootstrap-${config.max_active_jobs}`,
          );
        service.requireCapacityProfile();
      }
      if (
        !(await projection.latestAcl()) &&
        config.bootstrap_operator_subjects.length > 0
      ) {
        const operators = [...new Set(config.bootstrap_operator_subjects)].sort();
        const acl: OperatorAcl = {
          schema_version: "v1",
          kind: "operator.acl",
          record_id: deterministicId("operator-acl", sha256(operators.join("\u0000"))),
          created_at: new Date().toISOString(),
          actor: { subject: "harbor-hf-bootstrap", role: "migration" },
          operators,
          readers: [],
        };
        await service.append(acl);
      }
      initializationReady = true;
    },
    start(onReconcilerError?: (error: unknown) => void) {
      if (config.write_mode !== "disabled")
        reconciler.start(abort.signal, onReconcilerError);
    },
    async close() {
      initializationReady = false;
      abort.abort();
      await reconciler.stop();
      await workbench.close();
      await localHarbor.close();
      authStore.close();
      await projection.close();
    },
  };
}
