export interface RecordIdentity {
  kind: string;
  record_id: string;
  campaign_id?: string;
  action_id?: string;
  task_id?: string;
  attempt_id?: string;
  profile_kind?: string;
  alias?: string;
  publication_id?: string;
}

const idPattern = /^[a-z0-9][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

function required(value: string | undefined, field: string): string {
  if (!value) throw new Error(`${field} is required for this record path`);
  return value;
}

export function sandboxActionResultPath(campaignId: string, actionId: string): string {
  for (const [name, value] of [
    ["campaign_id", campaignId],
    ["action_id", actionId],
  ] as const) {
    if (!idPattern.test(value)) throw new Error(`${name} is not a safe identifier`);
  }
  return `sandbox-results/schema=v1/${campaignId}/${actionId}/result.json`;
}

export function workerEvidenceObjectPath(
  campaignId: string,
  actionId: string,
  taskId: string,
  digest: string,
): string {
  for (const [name, value] of [
    ["campaign_id", campaignId],
    ["action_id", actionId],
    ["task_id", taskId],
  ] as const) {
    if (!idPattern.test(value)) throw new Error(`${name} is not a safe identifier`);
  }
  if (!digestPattern.test(digest)) throw new Error("digest is invalid");
  return `evidence/schema=v1/campaigns/${campaignId}/actions/${actionId}/tasks/${taskId}/objects/${digest.slice("sha256:".length)}`;
}

export function controlRecordPath(record: RecordIdentity): string {
  const root = "control/schema=v1";
  switch (record.kind) {
    case "profile.object":
      return `${root}/profiles/objects/${required(record.profile_kind, "profile_kind")}/${record.record_id}.json`;
    case "profile.promotion":
      return `${root}/profiles/promotions/${required(record.profile_kind, "profile_kind")}/${required(record.alias, "alias")}/${record.record_id}.json`;
    case "operator.acl":
      return `${root}/operators/${record.record_id}.json`;
    case "campaign.request":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/request.json`;
    case "campaign.lock":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/campaign.lock.json`;
    case "prepared.trial":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/prepared/trials/${required(record.task_id, "task_id")}.json`;
    case "prepared.job":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/prepared/zz-manifest.json`;
    case "action.intent":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/actions/${required(record.action_id, "action_id")}/intent.json`;
    case "action.dispatch":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/actions/${required(record.action_id, "action_id")}/q-dispatch.json`;
    case "sandbox.admission":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/actions/${required(record.action_id, "action_id")}/p-admission.json`;
    case "sandbox.capacity-release":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/actions/${required(record.action_id, "action_id")}/zy-capacity-release.json`;
    case "action.receipt":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/actions/${required(record.action_id, "action_id")}/receipt.json`;
    case "action.disposition":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/actions/${required(record.action_id, "action_id")}/zzz-disposition.json`;
    case "action.advanced":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/actions/${required(record.action_id, "action_id")}/zz-advanced.json`;
    case "attempt.receipt":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/tasks/${required(record.task_id, "task_id")}/attempts/${required(record.attempt_id, "attempt_id")}/receipt.json`;
    case "terminal.selection":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/tasks/${required(record.task_id, "task_id")}/terminal/${record.record_id}.json`;
    case "budget.event":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/budgets/${record.record_id}.json`;
    case "endpoint.resource":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/resources/endpoints/${required(record.action_id, "action_id")}.json`;
    case "publication.receipt":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/publications/${required(record.publication_id, "publication_id")}.json`;
    case "migration.record":
      return `${root}/migrations/${record.record_id}.json`;
    default:
      throw new Error(`unsupported control record kind: ${record.kind}`);
  }
}
