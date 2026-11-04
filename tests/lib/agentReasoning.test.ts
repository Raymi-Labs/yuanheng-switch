import { describe, it, expect } from "vitest";
import { toolReasoningLevels } from "@/lib/agentReasoning";
describe("native reasoning capabilities", () => {
  it("intersects supported native levels without invented remapping", () => {
    expect(
      toolReasoningLevels("workbuddy", "gpt-6-astra", ["low", "max", "ultra"]),
    ).toEqual(["low", "max"]);
    expect(
      toolReasoningLevels("gemini", "gpt-6-astra", ["low", "high"]),
    ).toEqual([]);
    expect(
      toolReasoningLevels("gemini", "gemini-3-pro", ["low", "high", "xhigh"]),
    ).toEqual(["low", "high"]);
    expect(
      toolReasoningLevels("claude", "claude-sonnet-5", [
        "low",
        "high",
        "xhigh",
        "max",
      ]),
    ).toEqual(["low", "high", "xhigh", "max"]);
    expect(
      toolReasoningLevels("accio-work", "gpt-6-astra", ["low", "ultra"]),
    ).toEqual(["low", "ultra"]);
  });
});
