export interface Actor {
  subject: string;
  role: string;
}

export interface OperatorAcl {
  schema_version: "v1";
  kind: "operator.acl";
  record_id: string;
  created_at: string;
  actor: Actor;
  operators: string[];
  readers: string[];
}
