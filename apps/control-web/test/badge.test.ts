import { describe, expect, it } from "vitest";
import { badgeTone } from "../src/badge-tone";

describe("badgeTone", () => {
  it("treats complete as success and timeout as warning", () => {
    expect(badgeTone("complete")).toBe("success");
    expect(badgeTone("completed")).toBe("success");
    expect(badgeTone("benchmark_timeout")).toBe("warning");
    expect(badgeTone("cancelled")).toBe("cancel");
    expect(badgeTone("canceled")).toBe("cancel");
    expect(badgeTone("semantic")).toBe("danger");
    expect(badgeTone("running")).toBe("info");
    expect(badgeTone("pending")).toBe("neutral");
  });
});
