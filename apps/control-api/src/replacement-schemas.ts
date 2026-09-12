import { z } from "zod";
const runId = z.string().regex(/^run-[0-9a-f]{24}$/);
// Public review hash binds source evidence, selected UUIDs and budget.
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const trialIds = z
  .array(
    z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  )
  .min(1)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "Native trial UUIDs must be unique",
  )
  .meta({ uniqueItems: true });
export const replacementInputSchema = z.strictObject({
  trial_ids: trialIds,
  cost_ceiling_usd: z.number().positive().max(10_000),
});
export const replacementSubmissionSchema = replacementInputSchema.extend({
  fingerprint,
});
const selection = z.strictObject({
  original_run_id: runId,
  trial_ids: trialIds,
  source_fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export const replacementViewSchema = z.strictObject({
  run_id: runId,
  operator_selection: selection.nullable(),
  children: z.array(
    z.strictObject({
      run_id: runId,
      status: z
        .enum(["queued", "running", "paused", "cancelled", "finished", "cost_stopped"])
        .nullable(),
      operator_selection: selection,
    }),
  ),
  assembly: z.strictObject({
    availability: z.enum(["none", "pending", "available", "unavailable"]),
    result: z.record(z.string(), z.unknown()).nullable(),
  }),
  incurred: z
    .strictObject({
      cost_usd: z.number().nullable(),
      reported_attempts: z.number().int().nonnegative(),
      unknown_attempts: z.number().int().nonnegative(),
      total_attempts: z.number().int().nonnegative(),
    })
    .nullable(),
  selected_cost_usd: z.number().nullable(),
});

export const trialIdentitySchema = z.object({
  run_id: runId,
  trial_name: z.string(),
  reward: z.number().nullable(),
  cost_usd: z.number().nullable(),
  status: z.enum(["completed", "error", "cancelled"]),
  result: z.object({
    id: z.string().nullable(),
    exception_info: z.object({ exception_type: z.string().nullable() }).nullable(),
    config: z.object({
      agent: z.object({
        name: z.string().nullable(),
        import_path: z.string().nullable(),
        model_name: z.string().nullable(),
      }),
    }),
    agent_info: z.object({ version: z.string().nullable() }),
  }),
});
