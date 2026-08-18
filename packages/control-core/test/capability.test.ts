import { describe, expect, it } from "vitest";
import { mintWorkerCapability, verifyWorkerCapability } from "../src/capability.js";

const secret = "test-secret-not-a-real-credential";
const capability = {
  namespace: "example",
  campaign_id: "campaign-one",
  campaign_lock_digest: `sha256:${"a".repeat(64)}`,
  action_id: "action-one",
  task_ids: ["task-two", "task-one", "task-one"],
  operations: ["sandbox.create" as const, "campaign.read" as const],
  expires_at: 2_000_000_000,
};

describe("worker capabilities", () => {
  it("mints a scoped token and verifies its signature and expiration", () => {
    const token = mintWorkerCapability(secret, capability);

    expect(verifyWorkerCapability(secret, token, "example", 1_900_000_000_000)).toEqual(
      {
        version: 1,
        ...capability,
        task_ids: ["task-one", "task-two"],
        operations: ["campaign.read", "sandbox.create"],
      },
    );
    expect(verifyWorkerCapability(secret, `${token}x`, "example")).toBeNull();
    expect(
      verifyWorkerCapability(secret, token, "other", 1_900_000_000_000),
    ).toBeNull();
    expect(
      verifyWorkerCapability(secret, token, "example", 2_000_000_001_000),
    ).toBeNull();
  });
});
