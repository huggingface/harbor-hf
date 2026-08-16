import type { WorkerEvidenceManifestV1 } from "@harbor-hf/contracts";
import {
  canonicalJson,
  sha256,
  validateWorkerEvidenceManifest,
  workerEvidenceObjectPath,
} from "@harbor-hf/contracts";
import type { ImmutableObjectStore } from "./store.js";

export interface WorkerEvidenceIdentity {
  campaign_id: string;
  action_id: string;
  task_id: string;
  evidence_path: string;
  evidence_digest: string;
}

export class EvidenceIntegrityError extends Error {}

async function readVerified(
  store: ImmutableObjectStore,
  path: string,
  expectedDigest: string,
  expectedSize?: number,
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await store.read(path);
  } catch {
    throw new EvidenceIntegrityError("worker evidence object is missing");
  }
  if (sha256(bytes) !== expectedDigest)
    throw new EvidenceIntegrityError("worker evidence digest does not match");
  if (expectedSize !== undefined && bytes.byteLength !== expectedSize)
    throw new EvidenceIntegrityError("worker evidence size does not match");
  return bytes;
}

export async function verifyEvidenceReference(
  store: ImmutableObjectStore,
  evidencePath: string,
  evidenceDigest: string,
): Promise<void> {
  await readVerified(store, evidencePath, evidenceDigest);
}

export async function verifyWorkerEvidence(
  store: ImmutableObjectStore,
  identity: WorkerEvidenceIdentity,
): Promise<WorkerEvidenceManifestV1> {
  const expectedManifestPath = workerEvidenceObjectPath(
    identity.campaign_id,
    identity.action_id,
    identity.task_id,
    identity.evidence_digest,
  );
  if (identity.evidence_path !== expectedManifestPath)
    throw new EvidenceIntegrityError("worker evidence path is outside its scope");
  const bytes = await readVerified(
    store,
    identity.evidence_path,
    identity.evidence_digest,
  );
  let parsed: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw new EvidenceIntegrityError("worker evidence manifest is not valid JSON");
  }
  if (canonicalJson(parsed) !== text)
    throw new EvidenceIntegrityError("worker evidence manifest is not canonical JSON");
  let manifest: WorkerEvidenceManifestV1;
  try {
    manifest = validateWorkerEvidenceManifest<WorkerEvidenceManifestV1>(parsed);
  } catch {
    throw new EvidenceIntegrityError("worker evidence manifest is invalid");
  }
  if (
    manifest.campaign_id !== identity.campaign_id ||
    manifest.action_id !== identity.action_id ||
    manifest.task_id !== identity.task_id
  )
    throw new EvidenceIntegrityError("worker evidence manifest identity is invalid");
  for (const object of manifest.objects) {
    const expectedPath = workerEvidenceObjectPath(
      identity.campaign_id,
      identity.action_id,
      identity.task_id,
      object.digest,
    );
    if (object.path !== expectedPath || object.digest === identity.evidence_digest)
      throw new EvidenceIntegrityError("worker evidence object path is invalid");
    await readVerified(store, object.path, object.digest, object.size);
  }
  return manifest;
}
