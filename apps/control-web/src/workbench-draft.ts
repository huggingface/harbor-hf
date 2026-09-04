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
  selectedBenchmarkConfig: z.string(),
  hostedCeiling: z.number().nonnegative(),
});
export type WorkbenchDraft = z.infer<typeof draftSchema>;
export function loadWorkbenchDraft(): WorkbenchDraft | null {
  try {
    const parsed = draftSchema.safeParse(
      JSON.parse(window.localStorage.getItem(workbenchDraftKey) ?? "null"),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
export function saveWorkbenchDraft(draft: WorkbenchDraft): boolean {
  try {
    window.localStorage.setItem(workbenchDraftKey, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}
