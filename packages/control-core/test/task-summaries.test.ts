import { createTestControl, type TestControl } from "@harbor-hf/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";

const controls: TestControl[] = [];
afterEach(async () => {
  await Promise.all(controls.splice(0).map((control) => control.close()));
});
async function setup() {
  const control = await createTestControl();
  controls.push(control);
  const submitted = await control.service.submit(
    {
      benchmark: "control-smoke",
      model: "control-smoke",
      harness: "control-smoke",
      deployment: "hf-cpu-smoke",
      launch_policy: "control-smoke",
      ceiling_microusd: 0,
      confirmed: true,
    },
    "matrix-test",
    { subject: "operator", role: "operator" },
  );
  const task = (await control.projection.tasks(submitted.run_id))[0];
  if (!task) throw new Error("missing fixture task");
  return { control, task };
}

describe("read-only task summaries", () => {
  it("keeps missing rewards and unstarted trials explicit, and scopes by run", async () => {
    const { control, task } = await setup();
    expect(await control.projection.taskSummaries(task.run_id)).toEqual([
      {
        ...task,
        reward: null,
        attempt_count: 0,
        latest_outcome: null,
        last_attempt_at: null,
        cost_microusd: 0,
        pending_job_state: null,
      },
    ]);
    expect(await control.projection.taskSummaries("absent-run")).toEqual([]);
  });
  it.each([0, 0.5, 1, null])(
    "uses selected reward %s rather than a newer unselected attempt",
    async (reward) => {
      const { control, task } = await setup();
      await control.projection.db
        .insertInto("attempts")
        .values(
          [
            {
              ...task,
              attempt_id: "selected",
              action_id: "launch-selected",
              outcome: "complete",
              replacement_eligible: 0,
              evidence_digest: "digest",
              evidence_path: "evidence",
              cost_microusd: 10,
              metrics_body: JSON.stringify(reward === null ? {} : { reward }),
              created_at: "2026-09-08T00:00:00Z",
              body: "{}",
            },
            {
              ...task,
              attempt_id: "newer",
              action_id: "launch-newer",
              outcome: "infrastructure",
              replacement_eligible: 1,
              evidence_digest: "digest",
              evidence_path: "evidence",
              cost_microusd: 20,
              metrics_body: '{"reward":99}',
              created_at: "2026-09-08T00:01:00Z",
              body: "{}",
            },
          ].map(
            ({
              input_digest: _digest,
              terminal_outcome: _outcome,
              selected_attempt_id: _selected,
              ...row
            }) => row,
          ),
        )
        .execute();
      await control.projection.db
        .updateTable("tasks")
        .set({ selected_attempt_id: "selected", terminal_outcome: "complete" })
        .where("run_id", "=", task.run_id)
        .execute();
      expect((await control.projection.taskSummaries(task.run_id))[0]).toMatchObject({
        reward,
        attempt_count: 2,
        cost_microusd: 30,
        latest_outcome: "infrastructure",
        last_attempt_at: "2026-09-08T00:01:00Z",
        terminal_outcome: "complete",
      });
    },
  );
  it("tracks the latest launch, ignores suppressed work, and stops showing recorded jobs as pending", async () => {
    const { control, task } = await setup();
    const launches: string[] = [];
    for (const [index, state] of [
      "ERROR",
      "RUNNING",
      "suppressed-capacity",
    ].entries()) {
      const intent = control.service.actionIntent(
        task.run_id,
        "job.launch",
        `job-${index}`,
        index,
        { task_id: task.task_id, task_ids: [task.task_id] },
        { subject: "operator", role: "operator" },
        `2026-09-08T00:0${index}:00Z`,
      );
      launches.push(intent.action_id);
      await control.service.writeAction(intent);
      await control.service.receipt(intent, {
        outcome: "created",
        resource_id: `job-${index}`,
        observed_state: state,
        cost_microusd: 0,
      });
    }
    expect(
      (await control.projection.taskSummaries(task.run_id))[0]?.pending_job_state,
    ).toBe("RUNNING");
    await control.projection.db
      .insertInto("attempts")
      .values({
        run_id: task.run_id,
        task_id: task.task_id,
        attempt_id: "recorded",
        action_id: launches[1] as string,
        outcome: "complete",
        replacement_eligible: 0,
        evidence_digest: "digest",
        evidence_path: "evidence",
        cost_microusd: 0,
        metrics_body: '{"reward":0}',
        created_at: "2026-09-08T00:03:00Z",
        body: "{}",
      })
      .execute();
    expect((await control.projection.taskSummaries(task.run_id))[0]).toMatchObject({
      pending_job_state: null,
      latest_outcome: "complete",
      reward: null,
    });
  });
});
