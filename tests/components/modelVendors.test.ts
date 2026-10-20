import { describe, expect, it } from "vitest";
import {
  groupModelsByVendor,
  modelVendorOf,
  sortModelNames,
  resolveVendorFavorites,
} from "@/components/desktop/modelVendors";

describe("modelVendors", () => {
  it.each([
    ["gpt-5.6", "openai"],
    ["anthropic/claude-opus-4-8", "anthropic"],
    ["openrouter/google/gemini-3-pro", "google"],
    ["deepseek-v4-pro", "deepseek"],
    ["qwen3-coder", "qwen"],
    ["glm-5", "zhipu"],
    ["k3", "kimi"],
    ["doubao-seed-2.0", "doubao"],
  ])("识别 %s 的模型供应商", (model, vendor) => {
    expect(modelVendorOf(model).id).toBe(vendor);
  });

  it("按供应商聚合并保留每个模型", () => {
    const groups = groupModelsByVendor([
      "claude-sonnet-5",
      "gpt-5.6",
      "gpt-5.6-mini",
      "unknown-model",
    ]);

    expect(groups).toEqual([
      expect.objectContaining({
        id: "openai",
        models: ["gpt-5.6", "gpt-5.6-mini"],
      }),
      expect.objectContaining({
        id: "anthropic",
        models: ["claude-sonnet-5"],
      }),
      expect.objectContaining({
        id: "other",
        models: ["unknown-model"],
      }),
    ]);
  });

  it("同一供应商按稳定版本从新到旧排列", () => {
    expect(
      sortModelNames([
        "gpt-4.1-mini",
        "gpt-5.6-mini",
        "gpt-5.4",
        "gpt-5.6-preview",
        "gpt-5.6",
        "o4-mini",
      ]),
    ).toEqual([
      "gpt-5.6",
      "gpt-5.6-mini",
      "gpt-5.4",
      "gpt-4.1-mini",
      "o4-mini",
      "gpt-5.6-preview",
    ]);
  });

  it("同版本优先展示高能力档位并把预览版后置", () => {
    expect(
      sortModelNames([
        "claude-haiku-4-5",
        "claude-sonnet-4-8-preview",
        "claude-sonnet-4-7",
        "claude-sonnet-4-8",
        "claude-opus-4-8",
      ]),
    ).toEqual([
      "claude-opus-4-8",
      "claude-sonnet-4-8",
      "claude-sonnet-4-7",
      "claude-haiku-4-5",
      "claude-sonnet-4-8-preview",
    ]);
  });

  it("当前与推荐模型固定在最前，其余仍按统一规则排序", () => {
    expect(
      sortModelNames(
        ["gpt-5.4", "gpt-5.6-mini", "gpt-5.6", "gpt-4.1-mini"],
        ["gpt-5.4", "gpt-5.6-mini"],
      ),
    ).toEqual(["gpt-5.4", "gpt-5.6-mini", "gpt-5.6", "gpt-4.1-mini"]);
  });
});

describe("cloud vendor catalog", () => {
  const catalog = {
    "qwen-plus": { id: "16", name: "阿里百联大模型" },
    "custom-chat": { id: "42", name: "新厂商" },
    "another-chat": { id: "43", name: "新厂商" },
    "private-model": { id: "99", name: "不可见厂商" },
  };
  it("uses exact cloud associations and names ahead of heuristics without adding models", () => {
    const groups = groupModelsByVendor(
      ["qwen-plus", "custom-chat", "another-chat", "gpt-5.6"],
      catalog,
    );
    expect(groups).toHaveLength(4);
    expect(groups.find((group) => group.id === "cloud:16")).toMatchObject({
      label: "阿里百联大模型",
      legacyId: "qwen",
      icon: "qwen",
    });
    expect(
      groups
        .filter((group) => group.label === "新厂商")
        .map((group) => group.id),
    ).toEqual(["cloud:42", "cloud:43"]);
    expect(groups.some((group) => group.id === "cloud:99")).toBe(false);
    expect(modelVendorOf("gpt-5.6", catalog).id).toBe("openai");
    expect(modelVendorOf("custom-chat", catalog).label).toBe("新厂商");
  });
  it("does not merge mixed cloud vendors into heuristic favorites or use translated names", () => {
    const groups = groupModelsByVendor(["qwen-plus", "gpt-5.6"], {
      "qwen-plus": { id: "16", name: "其他模型" },
      "gpt-5.6": { id: "16", name: "其他模型" },
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: "cloud:16",
      label: "其他模型",
      icon: "models",
    });
    expect(groups[0].legacyId).toBeUndefined();
  });
});

it("keeps partial legacy favorites independent and expands completely migrated groups", () => {
  const catalog = {
    "qwen-plus": { id: "16", name: "阿里巴巴" },
    "qwen-max": { id: "42", name: "另一厂商" },
  };
  expect(
    resolveVendorFavorites(
      ["qwen", "absent"],
      groupModelsByVendor(["qwen-plus", "qwen-turbo"], catalog),
    ),
  ).toEqual(["qwen", "absent"]);
  expect(
    resolveVendorFavorites(
      ["qwen", "absent"],
      groupModelsByVendor(["qwen-plus", "qwen-max"], catalog),
    ).sort(),
  ).toEqual(["absent", "cloud:16", "cloud:42"]);
});
