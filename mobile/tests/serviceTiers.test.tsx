import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { Chat } from "../src/Chat";
import { api } from "../src/api";
import {
  buildChatBody,
  validateCapability,
  ChatSnapshot,
} from "../src/serviceTiers";
vi.mock("../src/App", () => ({
  Notice: ({ text }: { text: string }) => <p>{text}</p>,
}));
vi.mock("../src/api", async (original) => ({
  ...(await original<typeof import("../src/api")>()),
  api: {
    pricing: vi.fn(),
    get: vi.fn(),
    serviceTiers: vi.fn(),
    chat: vi.fn(),
    cancel: vi.fn(),
  },
}));
const caps = (model = "test-model", group = "a", paid = true) => ({
  model,
  group,
  managed: true,
  tiers: [
    { id: "default", multiplier: 1 },
    ...(paid
      ? [
          { id: "priority", multiplier: 2 },
          { id: "ultrafast", multiplier: 6 },
        ]
      : []),
  ],
});
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(api.pricing).mockResolvedValue({
    data: [{ model_name: "test-model", enable_groups: ["a", "b"] }],
    group_ratio: { a: 1, b: 1 },
  } as never);
  vi.mocked(api.get).mockResolvedValue({ a: {}, b: {} });
  vi.mocked(api.serviceTiers).mockImplementation(
    async (m, g) => caps(m, g) as never,
  );
  vi.mocked(api.cancel).mockResolvedValue();
  vi.mocked(api.chat).mockResolvedValue();
});
afterEach(cleanup);
async function open() {
  render(<Chat userId={7} defaultGroup="a" refresh={async () => {}} />);
  await waitFor(() => expect(api.serviceTiers).toHaveBeenCalled());
  await act(async () => {});
}
async function speed(name = "UltraFast") {
  fireEvent.click(screen.getByLabelText("选择速度"));
  fireEvent.click(await screen.findByText(name, { exact: true }));
  await act(async () => {});
}
async function send() {
  fireEvent.change(screen.getByLabelText("输入消息"), {
    target: { value: "hello" },
  });
  fireEvent.click(screen.getByLabelText("发送消息"));
  await act(async () => {});
}
describe("service tier contracts", () => {
  it("standard omits field; paid values are exact and capability mismatch is rejected", () => {
    const s: ChatSnapshot = {
      model: "m",
      group: "a",
      serviceTier: "default",
      multiplier: 1,
      messages: [{ role: "user", content: "hello" }],
    };
    expect(buildChatBody(s)).not.toHaveProperty("service_tier");
    expect(buildChatBody({ ...s, serviceTier: "priority" }).service_tier).toBe(
      "priority",
    );
    expect(buildChatBody({ ...s, serviceTier: "ultrafast" }).service_tier).toBe(
      "ultrafast",
    );
    expect(() => validateCapability(caps(), "wrong", "a")).toThrow();
    expect(() =>
      validateCapability(
        { ...caps(), tiers: [{ id: "priority", multiplier: 3 }] },
        "test-model",
        "a",
      ),
    ).toThrow();
  });
  it("404 leaves standard usable and never offers paid options", async () => {
    vi.mocked(api.serviceTiers).mockRejectedValue(Error("404"));
    await open();
    fireEvent.click(screen.getByLabelText("选择速度"));
    expect(screen.queryByText("Fast", { exact: true })).toBeNull();
    fireEvent.click(screen.getByText("标准", { exact: true }));
    await send();
    expect(api.chat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.chat).mock.calls[0][5]?.serviceTier).toBe("default");
  });
  it("saves per-conversation tier, revalidates restored access and resets new conversations", async () => {
    await open();
    await speed();
    await send();
    expect(api.chat).toHaveBeenCalledTimes(1);
    const rows = JSON.parse(
      localStorage.getItem("yuanheng-mobile-chats-v1:7")!,
    );
    expect(rows[0].serviceTier).toBe("ultrafast");
    cleanup();
    vi.mocked(api.serviceTiers).mockImplementation(
      async (m, g) => caps(m, g, false) as never,
    );
    render(<Chat userId={7} defaultGroup="a" refresh={async () => {}} />);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("不支持 UltraFast");
    await send();
    expect(api.chat).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("新建对话"));
    await act(async () => {});
    expect(screen.getAllByLabelText("选择速度")[0].textContent).toContain(
      "标准",
    );
  });
  it("group changes invalidate previous capability", async () => {
    await open();
    await speed();
    vi.mocked(api.serviceTiers).mockImplementation((m, g) =>
      g === "b"
        ? Promise.resolve(caps(m, g, false) as never)
        : Promise.resolve(caps(m, g) as never),
    );
    fireEvent.click(screen.getByLabelText("选择分组"));
    fireEvent.click(screen.getByText("b", { exact: true }));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("不支持 UltraFast");
    await send();
    expect(api.chat).not.toHaveBeenCalled();
  });
  it("ignores the old account's late capability and does not copy its tier", async () => {
    let late!: (v: never) => void;
    vi.mocked(api.serviceTiers).mockImplementation(
      () =>
        new Promise((r) => {
          late = r;
        }),
    );
    const v = render(
      <Chat key={7} userId={7} defaultGroup="a" refresh={async () => {}} />,
    );
    await waitFor(() => expect(api.serviceTiers).toHaveBeenCalled());
    vi.mocked(api.serviceTiers).mockImplementation(
      async (m, g) => caps(m, g, false) as never,
    );
    v.rerender(
      <Chat key={8} userId={8} defaultGroup="a" refresh={async () => {}} />,
    );
    await waitFor(() =>
      expect(api.serviceTiers).toHaveBeenCalledWith("test-model", "a", 8),
    );
    await act(async () => {
      late(caps() as never);
    });
    fireEvent.click(screen.getByLabelText("选择速度"));
    expect(screen.queryByText("UltraFast", { exact: true })).toBeNull();
    expect(
      screen.getByRole("button", { name: "选择速度" }).textContent,
    ).toContain("标准");
  });
  it("retry uses original paid snapshot after user chooses standard", async () => {
    vi.mocked(api.chat).mockRejectedValueOnce(Error("synthetic disconnect"));
    await open();
    await speed("Fast");
    await send();
    await screen.findByText("按原参数重试");
    await speed("标准");
    fireEvent.click(screen.getByText("按原参数重试"));
    await waitFor(() => expect(api.chat).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.chat).mock.calls[1][5]).toEqual(
      vi.mocked(api.chat).mock.calls[0][5],
    );
    expect(vi.mocked(api.chat).mock.calls[1][5]?.serviceTier).toBe("priority");
  });
  it("capability revoked between selection and send prevents a paid request", async () => {
    await open();
    await speed();
    vi.mocked(api.serviceTiers).mockImplementation(
      async (m, g) => caps(m, g, false) as never,
    );
    await send();
    expect(api.chat).not.toHaveBeenCalled();
    expect(screen.getByText(/或倍率已变化/)).toBeTruthy();
  });
  it("stop during paid revalidation prevents a late model send", async () => {
    await open();
    await speed("Fast");
    let finish!: (v: never) => void;
    vi.mocked(api.serviceTiers).mockImplementation(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    await send();
    fireEvent.click(screen.getByLabelText("停止生成"));
    await act(async () => {
      finish(caps() as never);
    });
    expect(api.chat).not.toHaveBeenCalled();
    expect(api.cancel).toHaveBeenCalledTimes(1);
  });
});
