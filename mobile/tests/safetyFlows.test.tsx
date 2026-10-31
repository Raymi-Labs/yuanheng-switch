import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Images } from "../src/Images";
import { Redemptions } from "../src/Redemptions";
import { api } from "../src/api";
import {
  readRedemptionAttempt,
  prepareRedemptionAttempt,
} from "../src/redemptionAttempt";
vi.mock("../src/App", () => ({
  Notice: ({ text }: { text: string }) => <p>{text}</p>,
  Money: () => null,
}));
vi.mock("../src/api", async (original) => {
  const rest = await original<typeof import("../src/api")>();
  return {
    ...rest,
    api: {
      get: vi.fn(),
      galleryList: vi.fn(),
      gallerySave: vi.fn(),
      galleryDelete: vi.fn(),
      image: vi.fn(),
      cancel: vi.fn(),
      saveImage: vi.fn(),
      redemptionSummary: vi.fn(),
      redemptions: vi.fn(),
      createRedemption: vi.fn(),
    },
  };
});
const summary = {
  minimum_quota: 1,
  daily_create_limit: 0,
  daily_quota_limit: 0,
  active_limit: 0,
  daily_created_count: 0,
  daily_created_quota: 0,
  active_count: 0,
};
const props = {
  userId: 1,
  perUnit: 1,
  price: 0.2,
  unit: "quota" as const,
  quotaLimit: 100,
  close: vi.fn(),
  refresh: vi.fn(async () => {}),
};
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.mocked(api.get).mockResolvedValue(["gpt-image-2"]);
  vi.mocked(api.galleryList).mockResolvedValue([]);
  vi.mocked(api.redemptionSummary).mockResolvedValue(summary);
  vi.mocked(api.redemptions).mockResolvedValue({ items: [], total: 0 });
  vi.mocked(api.createRedemption).mockRejectedValue(
    new Error("network timeout"),
  );
  vi.mocked(api.cancel).mockResolvedValue();
});
afterEach(async () => {
  await act(async () => {});
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function submit() {
  await screen.findByPlaceholderText("最低 1 额度");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: "创建兑换码" }));
}
describe("redemption safety", () => {
  it("keeps original id across an uncertain response and closing/reopening, even with depleted quota", async () => {
    const first = render(<Redemptions {...props} />);
    await submit();
    await screen.findByText(/network timeout/);
    const original = vi.mocked(api.createRedemption).mock.calls[0];
    expect(readRedemptionAttempt(1)?.requestId).toBe(original[1]);
    first.unmount();
    vi.mocked(api.redemptionSummary).mockResolvedValue({
      ...summary,
      active_limit: 1,
      active_count: 1,
    });
    vi.mocked(api.createRedemption).mockResolvedValue({
      redemption: {
        id: 1,
        key: "synthetic-result",
        quota: 10,
        status: 1,
        created_time: 1,
        expired_time: 0,
      },
    });
    render(<Redemptions {...props} quotaLimit={0} />);
    const retry = await screen.findByRole("button", { name: "确认原操作结果" });
    await act(async () => {
      fireEvent.click(retry);
    });
    await screen.findByText("synthetic-result");
    expect(vi.mocked(api.createRedemption).mock.calls[1]).toEqual(original);
    expect(readRedemptionAttempt(1)).toBeNull();
  });
  it("does not send a request when operation persistence fails", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    render(<Redemptions {...props} />);
    await submit();
    await screen.findByText(/未提交兑换码创建请求/);
    expect(api.createRedemption).not.toHaveBeenCalled();
  });
  it("preserves another account pending operation and prevents quota replacement", () => {
    const one = prepareRedemptionAttempt(1, 10);
    expect(readRedemptionAttempt(2)).toBeNull();
    const two = prepareRedemptionAttempt(2, 20);
    expect(two.requestId).not.toBe(one.requestId);
    expect(() => prepareRedemptionAttempt(1, 20)).toThrow(/待确认/);
    expect(readRedemptionAttempt(1)).toEqual(one);
  });
  it("blocks duplicate submits and leaves the id recoverable if success arrives after closing", async () => {
    let finish!: (v: Awaited<ReturnType<typeof api.createRedemption>>) => void;
    vi.mocked(api.createRedemption).mockImplementation(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const view = render(<Redemptions {...props} />);
    await submit();
    expect(api.createRedemption).toHaveBeenCalledTimes(1);
    view.unmount();
    const another = render(<Redemptions {...props} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "确认原操作结果" }),
    );
    await screen.findByText(/请求正在处理/);
    expect(api.createRedemption).toHaveBeenCalledTimes(1);
    another.unmount();
    await act(async () =>
      finish({
        redemption: {
          id: 1,
          key: "late-result",
          quota: 10,
          status: 1,
          created_time: 1,
          expired_time: 0,
        },
      }),
    );
    expect(readRedemptionAttempt(1)).not.toBeNull();
    expect(screen.queryByText("late-result")).toBeNull();
  });
  it("rejects corrupt persisted data without generating a new id", async () => {
    localStorage.setItem("yuanheng-mobile-redemption-v1:1", "broken");
    render(<Redemptions {...props} />);
    await screen.findByText(/操作记录损坏/);
    expect(
      (screen.getByRole("button", { name: "创建兑换码" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(api.createRedemption).not.toHaveBeenCalled();
  });
  it("cannot create new codes with zero available quota", async () => {
    render(<Redemptions {...props} quotaLimit={0} />);
    await submit();
    await screen.findByText(/可用额度不足/);
    expect(api.createRedemption).not.toHaveBeenCalled();
  });
});
describe("image safety", () => {
  const saved = {
    id: "stored",
    prompt: "text only",
    model: "gpt-image-2",
    size: "1024x1024",
    createdAt: 1,
    result: { mime: "image/png", data: "AQ==" },
  };
  it("ignores a late file read after reusing a text-only record", async () => {
    let reader!: { result: string; onload?: () => void; abort: () => void };
    vi.stubGlobal(
      "FileReader",
      class {
        result = "data:image/png;base64,cHJpdmF0ZQ==";
        onload?: () => void;
        onerror?: () => void;
        constructor() {
          reader = this;
        }
        readAsDataURL() {}
        abort() {}
      },
    );
    vi.mocked(api.galleryList).mockResolvedValue([saved]);
    const view = render(<Images userId={7} active refresh={async () => {}} />);
    await screen.findByRole("button", { name: "复用参数" });
    fireEvent.change(view.container.querySelector("input[type=file]")!, {
      target: { files: [new File(["x"], "x.png", { type: "image/png" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "复用参数" }));
    await act(async () => {
      reader.onload?.();
    });
    expect(screen.queryByAltText("参考图")).toBeNull();
    vi.unstubAllGlobals();
  });
  it("blocks repeated identical paid submissions while allowing different prompts", async () => {
    let finish!: (value: { data: string; mime: string }) => void;
    vi.mocked(api.image).mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const view = render(<Images userId={7} active refresh={async () => {}} />);
    fireEvent.change(screen.getByLabelText("画面描述"), {
      target: { value: "same request" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成图片" }));
    fireEvent.click(screen.getByRole("button", { name: "生成图片" }));
    expect(api.image).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/请勿重复提交/)).toBeTruthy();
    view.unmount();
    await act(async () => finish(saved.result));
  });
  it("clears old reference when reusing a text-only record", async () => {
    vi.mocked(api.galleryList).mockResolvedValue([saved]);
    vi.mocked(api.image).mockResolvedValue(saved.result);
    const view = render(<Images userId={7} active refresh={async () => {}} />);
    await screen.findByRole("button", { name: "复用参数" });
    fireEvent.change(view.container.querySelector("input[type=file]")!, {
      target: {
        files: [
          new File(["private-ref"], "reference.png", { type: "image/png" }),
        ],
      },
    });
    await screen.findByAltText("参考图");
    fireEvent.click(screen.getByRole("button", { name: "复用参数" }));
    expect(screen.queryByAltText("参考图")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "生成图片" }));
    await waitFor(() => expect(api.image).toHaveBeenCalled());
    expect(vi.mocked(api.image).mock.calls[0][4]).toBeUndefined();
  });
  it("does not hide a saved record when disk deletion fails", async () => {
    vi.mocked(api.galleryList).mockResolvedValue([saved]);
    vi.mocked(api.galleryDelete).mockRejectedValue(new Error("disk failure"));
    render(<Images userId={7} active refresh={async () => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "删除记录" }));
    await screen.findByText("disk failure");
    expect(
      screen.getByRole("button", { name: "查看记录：text only" }),
    ).toBeTruthy();
  });
  it("keeps four active tasks at most and cancels all on unmount", async () => {
    const ends: Array<(value: { data: string; mime: string }) => void> = [];
    vi.mocked(api.image).mockImplementation(
      () => new Promise((r) => ends.push(r)),
    );
    const view = render(<Images userId={7} active refresh={async () => {}} />);
    fireEvent.change(screen.getByLabelText("画面描述"), {
      target: { value: "scene" },
    });
    for (let n = 0; n < 6; n++) {
      fireEvent.change(screen.getByLabelText("画面描述"), {
        target: { value: `scene ${n}` },
      });
      fireEvent.click(screen.getByRole("button", { name: "生成图片" }));
    }
    expect(api.image).toHaveBeenCalledTimes(4);
    view.unmount();
    expect(api.cancel).toHaveBeenCalledTimes(4);
    await act(async () => {
      for (const done of ends) done(saved.result);
    });
  });
});
