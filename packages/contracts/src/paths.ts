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

function required(value: string | undefined, field: string): string {
  if (!value) throw new Error(`${field} is required for this record path`);
  return value;
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
    case "action.intent":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/actions/${required(record.action_id, "action_id")}/intent.json`;
    case "action.dispatch":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/actions/${required(record.action_id, "action_id")}/q-dispatch.json`;
    case "action.receipt":
      return `${root}/campaigns/${required(record.campaign_id, "campaign_id")}/actions/${required(record.action_id, "action_id")}/receipt.json`;
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
