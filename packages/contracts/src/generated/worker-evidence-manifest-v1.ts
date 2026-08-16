/* Generated from JSON Schema. Do not edit. */

export type WorkerEvidenceId = string
export type WorkerEvidenceDigest = string

export interface WorkerEvidenceManifestV1 {
schema_version: "v1"
kind: "worker.evidence.manifest"
campaign_id: WorkerEvidenceId
action_id: WorkerEvidenceId
task_id: WorkerEvidenceId
/**
 * @minItems 1
 * @maxItems 100000
 */
objects: [WorkerEvidenceObject, ...(WorkerEvidenceObject)[]]
}
export interface WorkerEvidenceObject {
path: string
digest: WorkerEvidenceDigest
size: number
}
