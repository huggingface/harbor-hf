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
  HuggingFaceActions,
  HuggingFaceBucketStore,
  NoopActions,
} from "@harbor-hf/hf-adapters";
import { AuthStore, AuthenticationService } from "./auth.js";
import type { AppConfig } from "./config.js";

export interface Runtime {
  config: AppConfig;
  projection: Projection;
  store: ImmutableObjectStore;
  service: ControlService;
  auth: AuthenticationService;
  reconciler: Reconciler;
  initialize(): Promise<void>;
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
  const authStore = await AuthStore.open(config.auth_path);
  const auth = new AuthenticationService(
    config.auth_mode,
    authStore,
    config.oauth,
    () => projection.latestAcl(),
  );
  const external = config.hf_token
    ? new HuggingFaceActions({
        namespace: config.namespace,
        accessToken: config.hf_token,
        bucketId: config.bucket_id,
        controlUrl: config.public_origin,
      })
    : new NoopActions();
  const publisher = new ResultPublisher(store, projection, service);
  const reconciler = new Reconciler(service, projection, external, publisher, {
    interval_ms: config.reconcile_interval_ms,
    observation_interval_ms: config.observe_interval_ms,
    batch_size: 16,
  });
  const abort = new AbortController();
  return {
    config,
    projection,
    store,
    service,
    auth,
    reconciler,
    async initialize() {
      await auth.initialize();
      await projection.rebuild(store);
      await service.initialize(profiles);
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
      if (config.write_mode !== "disabled") reconciler.start(abort.signal);
    },
    async close() {
      abort.abort();
      await reconciler.stop();
      authStore.close();
      await projection.close();
    },
  };
}
