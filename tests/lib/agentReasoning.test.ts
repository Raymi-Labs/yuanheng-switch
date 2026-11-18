import { describe, it, expect } from "vitest";
import {
  reasoningForSelection,
  toolReasoningLevels,
} from "@/lib/agentReasoning";

it("does not silently reset a retired saved level on the same model", () => {
  expect(reasoningForSelection("ultra", ["low"], "ultra")).toBe("ultra");
  expect(reasoningForSelection("ultra", ["low"])).toBe("auto");
  expect(reasoningForSelection("auto", ["low"], "ultra")).toBe("auto");
});
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
