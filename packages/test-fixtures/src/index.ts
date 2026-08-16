import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProfileObject } from "@harbor-hf/contracts";
import { canonicalJson, sha256 } from "@harbor-hf/contracts";
import {
  ControlService,
  FilesystemObjectStore,
  Projection,
  type LoadedProfile,
} from "@harbor-hf/control-core";

export function profile(
  profile_kind: ProfileObject["profile_kind"],
  name: string,
  spec: ProfileObject["spec"],
): LoadedProfile {
  const value = {
    schema_version: "v1",
    kind: "profile.object",
    record_id: `profile-${name}-${profile_kind.replace("_", "-")}`,
    created_at: "2026-08-16T00:00:00.000Z",
    actor: { subject: "test", role: "service" },
    profile_kind,
    name,
    spec,
  } as unknown as ProfileObject;
  return { profile: value, profile_id: sha256(canonicalJson(value)) };
}

export function smokeProfiles(
  taskCount = 1,
  maxInfrastructureAttempts = 1,
  reservationMicrousd = 0,
): LoadedProfile[] {
  if (taskCount < 1) throw new Error("test campaign needs at least one task");
  const taskIds = Array.from(
    { length: taskCount },
    (_, index) => `task-${String(index + 1).padStart(3, "0")}`,
  );
  return [
    profile("benchmark", "control-smoke", {
      task_ids: [taskIds[0] as string, ...taskIds.slice(1)],
      task_digests: [
        sha256(taskIds[0] as string),
        ...taskIds.slice(1).map((id) => sha256(id)),
      ],
      benchmark: "control-smoke",
      revision: sha256("benchmark"),
    }),
    profile("model", "control-smoke", {
      model_id: "control-smoke",
      revision: sha256("model"),
    }),
    profile("harness", "control-smoke", {
      agent: "control-smoke",
      revision: sha256("harness"),
      required_evidence: ["job-status"],
    }),
    profile("deployment", "hf-cpu-smoke", {
      route: "hf_job",
      models: ["control-smoke"],
      harnesses: ["control-smoke"],
      job_image:
        "example.invalid/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      job_command: ["true"],
      hardware: "cpu-basic",
      timeout_seconds: 300,
      trusted_worker: true,
    }),
    profile("launch_policy", "control-smoke", {
      max_infrastructure_attempts: maxInfrastructureAttempts,
      reservation_microusd: reservationMicrousd,
      success_without_worker_receipt: true,
      publication_role: "diagnostic",
    }),
  ];
}

export interface TestControl {
  root: string;
  bucket: string;
  store: FilesystemObjectStore;
  projection: Projection;
  service: ControlService;
  profiles: LoadedProfile[];
  close(): Promise<void>;
}

export async function createTestControl(
  taskCount = 1,
  maxInfrastructureAttempts = 1,
  reservationMicrousd = 0,
): Promise<TestControl> {
  const root = await mkdtemp(join(tmpdir(), "harbor-hf-control-test-"));
  const bucket = join(root, "bucket");
  await mkdir(bucket, { recursive: true });
  const store = new FilesystemObjectStore(bucket);
  const projection = await Projection.open(join(root, "projection.sqlite"));
  const profiles = smokeProfiles(
    taskCount,
    maxInfrastructureAttempts,
    reservationMicrousd,
  );
  const service = new ControlService("test", store, projection, profiles);
  await projection.rebuild(store);
  await service.initialize(profiles);
  return {
    root,
    bucket,
    store,
    projection,
    service,
    profiles,
    async close() {
      await projection.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
