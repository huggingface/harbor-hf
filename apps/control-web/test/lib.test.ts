import { describe, expect, it } from "vitest";
import { estimateLaunchReservationMicrousd } from "../src/lib";

describe("launch reservation estimate", () => {
  it("counts one execution reservation per worker Job", () => {
    expect(
      estimateLaunchReservationMicrousd(
        445,
        {
          preparation: "required",
          worker_max_tasks_per_job: 445,
        },
        {
          reservation_microusd: 5_100_000,
          preparation_reservation_microusd: 100_000,
          max_preparation_attempts: 2,
        },
      ),
    ).toBe(5_300_000);
  });

  it("counts each bounded execution batch", () => {
    expect(
      estimateLaunchReservationMicrousd(
        10,
        { worker_max_tasks_per_job: 4 },
        { reservation_microusd: 1_000_000 },
      ),
    ).toBe(3_000_000);
  });
});
