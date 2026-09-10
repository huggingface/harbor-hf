import { containsCredentialMaterial } from "@harbor-hf/contracts/credentials";
import { z } from "zod";

export const workbenchDraftKey = "harbor-hf.workbench.draft.v1";

// Validate structure, not compiler rules: incomplete edits must survive reload too.
const draftSchema = z.object({
  recipe: z.object({
    schema_version: z.literal("v1"),
    name: z.string(),
    setup_command: z.string(),
    run_command: z.string(),
    route_api: z.enum(["chat-completions", "responses"]),
    setup_timeout_seconds: z.number(),
    environment: z.array(
      z
        .object({
          name: z.string(),
          source: z.enum([
            "literal",
            "instruction_path",
            "workspace_path",
            "logs_path",
            "agent_home",
            "model_name",
            "model_base_url",
            "model_api_key",
          ]),
          value: z.string().optional(),
        })
        .transform(({ value, ...binding }) =>
          value === undefined ? binding : { ...binding, value },
        ),
    ),
    outputs: z.object({
      results_path: z.string(),
      trajectory_path: z.string().nullable(),
    }),
  }),
  pricing: z
    .object({
      enabled: z.boolean(),
      input: z.string(),
      output: z.string(),
      cached: z.string(),
    })
    .optional(),
  benchmarkKey: z.string(),
  n_concurrent_trials: z.string().optional(),
  model: z.string(),
  harbor_agent: z.object({ model_name: z.string() }).optional(),
  provider: z.string(),
  reasoning_effort: z.string().optional(),
  ceiling: z.string(),
  role: z.enum(["final", "diagnostic"]),
});

export type WorkbenchDraft = z.infer<typeof draftSchema>;

// Keep incomplete safe edits verbatim; submission validation is stricter.
// Remove only reasoning, including from older drafts with unrecognized fields.
function withoutCredentialReasoning(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "reasoning_effort" in value &&
    containsCredentialMaterial(value.reasoning_effort)
  ) {
    const { reasoning_effort: _reasoning, ...rest } = value;
    return rest;
  }
  return value;
}

export function loadWorkbenchDraft(): WorkbenchDraft | null {
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(workbenchDraftKey) ?? "null",
    );
    const safe = withoutCredentialReasoning(stored);
    if (safe !== stored) {
      try {
        window.localStorage.setItem(workbenchDraftKey, JSON.stringify(safe));
      } catch {
        // If rewriting is blocked, try to remove the contaminated copy.
        try {
          window.localStorage.removeItem(workbenchDraftKey);
        } catch {
          // Unavailable storage must not restore unsafe reasoning into the UI.
        }
      }
    }
    const parsed = draftSchema.safeParse(safe);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveWorkbenchDraft(draft: WorkbenchDraft): boolean {
  try {
    window.localStorage.setItem(
      workbenchDraftKey,
      JSON.stringify(withoutCredentialReasoning(draft)),
    );
    return true;
  } catch {
    return false;
  }
}

// Defer serialization as well as storage: neither belongs on the typing path.
export function createWorkbenchDraftSaver(onSaved: (saved: boolean) => void) {
  let pending: WorkbenchDraft | null = null;
  let timer: number | undefined;
  function flush() {
    window.clearTimeout(timer);
    timer = undefined;
    if (!pending) return;
    const draft = pending;
    pending = null;
    onSaved(saveWorkbenchDraft(draft));
  }
  return {
    schedule(draft: WorkbenchDraft) {
      pending = draft;
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, 400);
    },
    flush,
  };
}
