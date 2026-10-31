import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MediaStudioPage,
  MEDIA_POLL_DELAY,
  MEDIA_POLL_LIMIT,
  MUSE_POLL_LIMIT,
} from "@/components/desktop/MediaStudioPage";
import { createTestQueryClient } from "../utils/testQueryClient";
import type { MediaRecord } from "@/lib/api/media-studio";

const mocks = vi.hoisted(() => ({
  account: { connected: true, userId: "one", baseUrl: "https://meta-api.vip" },
  models: vi.fn(),
  history: vi.fn(),
  submit: vi.fn(),
  refresh: vi.fn(),
  preview: vi.fn(),
  prepareVideoReference: vi.fn(),
  export: vi.fn(),
  delete: vi.fn(),
  save: vi.fn(),
  saveDialog: vi.fn(),
}));
vi.mock("@/lib/api/media-studio", () => ({ mediaStudioApi: mocks }));
vi.mock("@/lib/query/yuanheng", () => ({
  useYuanhengConnection: () => ({ data: mocks.account }),
}));
vi.mock("@/lib/api", () => ({ settingsApi: { saveFileDialog: mocks.save } }));
const item = (patch: Partial<MediaRecord> = {}): MediaRecord => ({
  id: "11111111-1111-4111-8111-111111111111",
  model: "muse-video",
  kind: "video",
  status: "queued",
  createdAt: 10,
  taskId: "task_one",
  message: "任务排队中",
  hasMedia: false,
  ...patch,
});
const profiles = [
  {
    id: "gpt-image-2.5-sunburst",
    kind: "image",
    reference: "optional",
    sizes: ["1024x1024"],
    durations: [],
  },
  {
    id: "grok-imagine-image",
    kind: "image",
    reference: "none",
    sizes: ["auto"],
    durations: [],
  },
  {
    id: "muse-video",
    kind: "video",
    reference: "optional",
    sizes: ["1280x720"],
    durations: Array.from({ length: 177 }, (_, i) => i + 4),
  },
  {
    id: "synthetic-required-reference-profile",
    kind: "video",
    reference: "required",
    sizes: ["1280x720"],
    durations: [8],
  },
];
let client: ReturnType<typeof createTestQueryClient>;
function mount() {
  client = createTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MediaStudioPage />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.account = {
    connected: true,
    userId: "one",
    baseUrl: "https://meta-api.vip",
  };
  mocks.models.mockResolvedValue(profiles);
  mocks.history.mockResolvedValue([]);
  mocks.submit.mockResolvedValue(item());
  mocks.refresh.mockResolvedValue(item());
  mocks.preview.mockResolvedValue({ mime: "image/png", data: btoa("test") });
  mocks.prepareVideoReference.mockResolvedValue({
    mime: "image/png",
    data: btoa("prepared-image"),
  });
  mocks.save.mockResolvedValue("/tmp/synthetic.png");
  mocks.saveDialog.mockResolvedValue("/tmp/synthetic.png");
  mocks.export.mockResolvedValue(undefined);
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:synthetic-media");
      static revokeObjectURL = vi.fn();
    },
  );
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("media creation workflow", () => {
  it("saves videos through an MP4 dialog and cancellation never exports", async () => {
    mocks.history.mockResolvedValue([item({ status: "completed" })]);
    mocks.saveDialog
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("/tmp/output.mp4");
    mount();
    await screen.findByRole("button", { name: "保存" });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(mocks.saveDialog).toHaveBeenCalledWith(
        `yuanheng-${item().id}.mp4`,
        "mp4",
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存" })).toBeEnabled(),
    );
    expect(mocks.export).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(mocks.export).toHaveBeenCalledWith(item().id, "/tmp/output.mp4"),
    );
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([
    ["image/jpeg", "jpg"],
    ["image/webp", "webp"],
  ])("selects the actual %s image filter", async (mime, extension) => {
    mocks.history.mockResolvedValue([
      item({ kind: "image", status: "completed", taskId: null }),
    ]);
    mocks.preview.mockResolvedValue({ mime, data: btoa("image") });
    mocks.saveDialog.mockResolvedValue(null);
    mount();
    await screen.findByRole("button", { name: "保存" });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(mocks.saveDialog).toHaveBeenCalledWith(
        `yuanheng-${item().id}.${extension}`,
        extension,
      ),
    );
    expect(mocks.export).not.toHaveBeenCalled();
  });
  it("accepts 180 seconds, rejects fractions and enforces the Muse prompt limit", async () => {
    mount();
    await screen.findByRole("option", { name: "gpt-image-2.5-sunburst" });
    fireEvent.click(screen.getByRole("tab", { name: "视频生成" }));
    await screen.findByRole("option", { name: "muse-video" });
    fireEvent.click(screen.getByText("更多设置"));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "a".repeat(4001) },
    });
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Muse时长（秒）" }),
      { target: { value: "180" } },
    );
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "a".repeat(4000) },
    });
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Muse时长（秒）" }),
      { target: { value: "8.5" } },
    );
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Muse时长（秒）" }),
      { target: { value: "180" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0][0]).toMatchObject({
      model: "muse-video",
      duration: 180,
      reference: null,
    });
  });
  it("orders Muse references and sends only images for multi-image input", async () => {
    mount();
    await screen.findByRole("option", { name: "gpt-image-2.5-sunburst" });
    fireEvent.click(screen.getByRole("tab", { name: "视频生成" }));
    await screen.findByRole("option", { name: "muse-video" });
    const file = (s: string, type = "image/png") => {
      const f = new File([s], "reference", { type });
      Object.defineProperty(f, "arrayBuffer", {
        value: async () => new TextEncoder().encode(s).buffer,
      });
      return f;
    };
    fireEvent.change(screen.getByLabelText("选择参考图"), {
      target: {
        files: [
          file("first"),
          file("second", "image/webp"),
          file("third"),
          file("fourth"),
        ],
      },
    });
    await screen.findByRole("img", { name: "参考图 4" });
    expect(screen.getByRole("note")).toHaveTextContent("第2–4张的效果不保证");
    expect(screen.getByLabelText("选择参考图")).toHaveAttribute("multiple");
    fireEvent.click(screen.getAllByRole("button", { name: "前移" })[0]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "镜头向前" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0][0]).toMatchObject({
      reference: null,
      images: [
        `data:image/webp;base64,${btoa("second")}`,
        `data:image/png;base64,${btoa("first")}`,
        `data:image/png;base64,${btoa("third")}`,
        `data:image/png;base64,${btoa("fourth")}`,
      ],
    });
  });
  it("rejects Muse reference count and aggregate bytes before reading files", async () => {
    mount();
    await screen.findByRole("option", { name: "gpt-image-2.5-sunburst" });
    fireEvent.click(screen.getByRole("tab", { name: "视频生成" }));
    await screen.findByRole("option", { name: "muse-video" });
    const read = vi.fn();
    const file = new File(["x"], "image.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", { value: read });
    fireEvent.change(screen.getByLabelText("选择参考图"), {
      target: { files: Array(5).fill(file) },
    });
    expect(screen.getByRole("status")).toHaveTextContent("最多4张");
    expect(read).not.toHaveBeenCalled();
    Object.defineProperty(file, "size", { value: 9 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText("选择参考图"), {
      target: { files: Array(3).fill(file) },
    });
    expect(screen.getByRole("status")).toHaveTextContent("总计最多24MB");
    expect(read).not.toHaveBeenCalled();
  });
  it("prepares an image-to-video draft without a paid submission", async () => {
    mocks.history.mockResolvedValue([
      item({ kind: "image", status: "completed", taskId: null }),
    ]);
    mount();
    const transfer = await screen.findByRole("button", {
      name: "用作视频参考图",
    });
    await waitFor(() => expect(transfer).toBeEnabled());
    fireEvent.click(transfer);
    expect(await screen.findByRole("img", { name: "参考图" })).toHaveAttribute(
      "src",
      `data:image/png;base64,${btoa("prepared-image")}`,
    );
    expect(screen.getByRole("tab", { name: "视频生成" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "生成模型" })).toHaveValue(
      "muse-video",
    );
    expect(mocks.prepareVideoReference).toHaveBeenCalledWith(item().id);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "缓慢向前移动" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0][0]).toMatchObject({
      model: "muse-video",
      reference: `data:image/png;base64,${btoa("prepared-image")}`,
      duration: 4,
    });
  });
  it("cannot transfer to video without an authorized reference-capable model", async () => {
    mocks.models.mockResolvedValue(profiles.filter((p) => p.kind === "image"));
    mocks.history.mockResolvedValue([
      item({ kind: "image", status: "completed", taskId: null }),
    ]);
    mount();
    expect(
      await screen.findByRole("button", { name: "用作视频参考图" }),
    ).toBeDisabled();
    expect(mocks.prepareVideoReference).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("preserves the draft across compatible models and warns before text-only mode", async () => {
    mocks.models.mockResolvedValue([
      ...profiles,
      {
        id: "grok-imagine-video",
        kind: "video",
        reference: "none",
        sizes: ["16:9"],
        durations: [1],
      },
    ]);
    mocks.history.mockResolvedValue([
      item({ kind: "image", status: "completed", taskId: null }),
    ]);
    mount();
    const transfer = await screen.findByRole("button", {
      name: "用作视频参考图",
    });
    await waitFor(() => expect(transfer).toBeEnabled());
    fireEvent.click(transfer);
    await screen.findByRole("img", { name: "参考图" });
    fireEvent.change(screen.getByRole("combobox", { name: "生成模型" }), {
      target: { value: "synthetic-required-reference-profile" },
    });
    expect(screen.getByRole("img", { name: "参考图" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "生成模型" }), {
      target: { value: "grok-imagine-video" },
    });
    expect(
      screen.queryByRole("img", { name: "参考图" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已移除图片");
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("drops a prepared private image if the account changes during conversion", async () => {
    let finish!: (v: { data: string; mime: string }) => void;
    mocks.prepareVideoReference.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    mocks.history.mockResolvedValue([
      item({ kind: "image", status: "completed", taskId: null }),
    ]);
    const view = mount();
    const transfer = await screen.findByRole("button", {
      name: "用作视频参考图",
    });
    await waitFor(() => expect(transfer).toBeEnabled());
    fireEvent.click(transfer);
    expect(screen.getByRole("tab", { name: "视频生成" })).toBeDisabled();
    mocks.account = { ...mocks.account, userId: "two" };
    mocks.history.mockResolvedValue([]);
    view.rerender(
      <QueryClientProvider client={client}>
        <MediaStudioPage />
      </QueryClientProvider>,
    );
    await act(async () => finish({ mime: "image/png", data: btoa("private") }));
    expect(
      screen.queryByRole("img", { name: "参考图" }),
    ).not.toBeInTheDocument();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("retries only the original image download after a download failure", async () => {
    mocks.history.mockResolvedValue([
      item({
        kind: "image",
        status: "completed",
        taskId: null,
        hasMedia: false,
      }),
    ]);
    mocks.preview.mockRejectedValueOnce(
      new Error("图片下载失败，原记录已保留"),
    );
    mount();
    await screen.findByRole("button", { name: "预览" });
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(await screen.findByRole("status")).toHaveTextContent("原记录已保留");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "预览" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(
      await screen.findByRole("img", { name: "生成结果" }),
    ).toBeInTheDocument();
    expect(mocks.preview.mock.calls).toEqual([[item().id], [item().id]]);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("never replaces an explicit model when a refreshed catalog removes it", async () => {
    mount();
    await screen.findByRole("option", { name: "gpt-image-2.5-sunburst" });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "scene" },
    });
    mocks.models.mockResolvedValue(
      profiles.filter((p) => p.id !== "gpt-image-2.5-sunburst"),
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "不会自动换模型",
    );
    expect(screen.getByRole("combobox", { name: "生成模型" })).toHaveValue(
      "gpt-image-2.5-sunburst",
    );
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("shows the fixed group and supported catalog without submitting on mount", async () => {
    mount();
    expect(
      await screen.findByRole("option", { name: "gpt-image-2.5-sunburst" }),
    ).toBeInTheDocument();
    expect(screen.getByText("分组：生图和视频")).toBeInTheDocument();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("option", { name: "muse-video" }),
    ).not.toBeInTheDocument();
  });
  it("submits exactly once, preserving chosen model and explicit media parameters", async () => {
    let resolve!: (r: MediaRecord) => void;
    mocks.submit.mockImplementation(
      () =>
        new Promise<MediaRecord>((r) => {
          resolve = r;
        }),
    );
    mount();
    await screen.findByRole("option", { name: "gpt-image-2.5-sunburst" });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "synthetic scene" },
    });
    const button = screen.getByRole("button", { name: "生成" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(mocks.submit.mock.calls[0][0]).toMatchObject({
      model: "gpt-image-2.5-sunburst",
      prompt: "synthetic scene",
      size: "1024x1024",
      reference: null,
      duration: null,
    });
    expect(mocks.submit.mock.calls[0][0]).not.toHaveProperty("group");
    await act(async () =>
      resolve(
        item({
          kind: "image",
          model: "gpt-image-2.5-sunburst",
          status: "completed",
          taskId: null,
          message: "已完成",
        }),
      ),
    );
    expect(
      await screen.findByRole("button", { name: "预览" }),
    ).toBeInTheDocument();
  });
  it("blocks generation when the catalog is unavailable, without a fallback group", async () => {
    mocks.models.mockRejectedValue(new Error("分组不可用"));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("分组不可用");
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hello" },
    });
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("respects a profile requiring a reference before allowing submission", async () => {
    mount();
    await screen.findByRole("option", { name: "gpt-image-2.5-sunburst" });
    fireEvent.click(screen.getByRole("tab", { name: "视频生成" }));
    expect(
      screen.getByText(
        "Muse提交最长等待30分钟。返回任务编号后继续查询；超时不会自动重发。",
      ),
    ).toBeInTheDocument();
    await screen.findByRole("option", { name: "muse-video" });
    fireEvent.change(screen.getByRole("combobox", { name: "生成模型" }), {
      target: { value: "synthetic-required-reference-profile" },
    });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hello" },
    });
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "上传参考图（必选）" }),
    ).toBeInTheDocument();
  });
  it("retains unknown submissions without automatic retry", async () => {
    mocks.submit.mockResolvedValue(
      item({
        status: "unknown",
        taskId: null,
        message: "结果未知，请勿重复提交",
      }),
    );
    mount();
    await screen.findByRole("option", { name: "gpt-image-2.5-sunburst" });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    expect(await screen.findByRole("status")).toHaveTextContent("结果未知");
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it.each([
    ["muse-video", MUSE_POLL_LIMIT],
    ["grok-imagine-video", MEDIA_POLL_LIMIT],
  ] as const)(
    "resumes %s tasks with bounded sequential queries and no submissions",
    async (model, limit) => {
      mocks.history.mockResolvedValue([item({ model })]);
      mocks.refresh.mockResolvedValue(item({ model }));
      const view = mount();
      await screen.findByRole("button", { name: "继续查询" });
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole("button", { name: "继续查询" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      for (let i = 1; i < limit; i++)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(MEDIA_POLL_DELAY);
        });
      expect(mocks.refresh).toHaveBeenCalledTimes(limit);
      expect(mocks.refresh).toHaveBeenLastCalledWith(item().id);
      expect(screen.getByRole("status")).toHaveTextContent("已暂停自动等待");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MEDIA_POLL_DELAY * 3);
      });
      expect(mocks.refresh).toHaveBeenCalledTimes(limit);
      expect(mocks.submit).not.toHaveBeenCalled();
      view.unmount();
      client.clear();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("pauses polling on query failure and keeps the original task", async () => {
    mocks.history.mockResolvedValue([item()]);
    mocks.refresh.mockRejectedValue(new Error("查询超时"));
    mount();
    await screen.findByRole("button", { name: "继续查询" });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "继续查询" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByRole("status")).toHaveTextContent("查询超时");
    expect(screen.getByText("task_one")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
  it("does not expose old results after switching accounts during submission", async () => {
    let resolve!: (r: MediaRecord) => void;
    mocks.submit.mockImplementation(
      () =>
        new Promise<MediaRecord>((r) => {
          resolve = r;
        }),
    );
    const view = mount();
    await screen.findByRole("option", { name: "gpt-image-2.5-sunburst" });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "private old prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    mocks.account = { ...mocks.account, userId: "two" };
    view.rerender(
      <QueryClientProvider client={client}>
        <MediaStudioPage />
      </QueryClientProvider>,
    );
    await act(async () => resolve(item({ message: "private-old-result" })));
    expect(screen.queryByText("private-old-result")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("previews only on demand, exports via a save dialog, and releases blob URLs", async () => {
    mocks.history.mockResolvedValue([
      item({ kind: "image", status: "completed", taskId: null }),
    ]);
    const view = mount();
    await screen.findByRole("button", { name: "预览" });
    expect(mocks.preview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(
      await screen.findByRole("img", { name: "生成结果" }),
    ).toHaveAttribute("src", "blob:synthetic-media");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(mocks.export).toHaveBeenCalledWith(
        item().id,
        "/tmp/synthetic.png",
      ),
    );
    expect(mocks.saveDialog).toHaveBeenCalledWith(
      `yuanheng-${item().id}.png`,
      "png",
    );
    expect(mocks.save).not.toHaveBeenCalled();
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-media");
  });
});
