/* Generated from JSON Schema. Do not edit. */

export type SavedHarborConfiguration = import("./harbor-job-config-v1.js").HarborJobConfigV1

export interface SavedWorkbenchConfigurationV1 {
schema_version: "v1"
revision: string
name: string
harbor_job_config: SavedHarborConfiguration
}
