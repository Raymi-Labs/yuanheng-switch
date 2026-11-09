import { beforeEach, describe, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
import { api } from "../src/api";
beforeEach(() =>
  invoke.mockReset().mockResolvedValue({ success: true, data: {} }),
);
describe("account-bound native commands", () => {
  it("includes the initiating user on all gallery operations", async () => {
    await api.galleryList(7);
    expect(invoke).toHaveBeenLastCalledWith("mobile_gallery_list", {
      userId: 7,
    });
    const entry = {
      id: "one",
      prompt: "p",
      model: "m",
      size: "s",
      createdAt: 1,
      result: { data: "AQ==", mime: "image/png" },
    };
    await api.gallerySave(entry, 7);
    expect(invoke).toHaveBeenLastCalledWith("mobile_gallery_save", {
      entry: JSON.stringify(entry),
      userId: 7,
    });
    await api.galleryDelete("one", 7);
    expect(invoke).toHaveBeenLastCalledWith("mobile_gallery_delete", {
      id: "one",
      userId: 7,
    });
  });
  it("binds financial writes to the initiating user, separate from upstream payload", async () => {
    await api.createRedemption(10, "synthetic-id", 7);
    expect(invoke).toHaveBeenLastCalledWith("mobile_api", {
      operation: "redemption_create",
      expectedUserId: 7,
      body: { quota: 10, request_id: "synthetic-id" },
    });
    await api.transferAffQuota(10, 7);
    expect(invoke).toHaveBeenLastCalledWith("mobile_api", {
      operation: "aff_transfer",
      expectedUserId: 7,
      body: { quota: 10 },
    });
  });
});
