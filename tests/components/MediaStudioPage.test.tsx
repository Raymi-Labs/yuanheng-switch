import { MEDIA_INSPIRATION } from "@/lib/mediaInspiration";
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
  groups: vi.fn(),
  selectGroup: vi.fn(),
  models: vi.fn(),
  history: vi.fn(),
  submit: vi.fn(),
  refresh: vi.fn(),
  preview: vi.fn(),
  prepareVideoReference: vi.fn(),
  export: vi.fn(),
  delete: vi.fn(),
  forgetPrompt: vi.fn(),
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
function mount(explore = false) {
  client = createTestQueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <MediaStudioPage />
    </QueryClientProvider>,
  );
  if (!explore)
    fireEvent.click(screen.getByRole("tab", { name: "创作工作台" }));
  return view;
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.account = {
    connected: true,
    userId: "one",
    baseUrl: "https://meta-api.vip",
  };
  mocks.groups.mockResolvedValue({
    groups: [
      { id: "生图和视频", description: "", ratio: 1 },
      { id: "伙伴创作", description: "", ratio: 2 },
    ],
    selectedGroup: "生图和视频",
  });
  mocks.selectGroup.mockImplementation(async (group: string) => group);
  mocks.models.mockResolvedValue(profiles);
  mocks.history.mockResolvedValue([]);
  mocks.forgetPrompt.mockResolvedValue(undefined);
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

function clipboardImage(value: string, type = "image/png") {
  const file = new File([value], "clipboard.png", { type });
  Object.defineProperty(file, "arrayBuffer", {
    value: vi.fn(async () => new TextEncoder().encode(value).buffer),
    configurable: true,
  });
  return file;
}
function pasteImages(files: File[], itemsOnly = false) {
  return fireEvent.paste(screen.getByRole("textbox"), {
    clipboardData: {
      files: itemsOnly ? [] : files,
      items: files.map((file) => ({
        kind: "file",
        type: file.type,
        getAsFile: () => file,
      })),
    },
  });
}

describe("media group selection boundaries", () => {
  const groupSelect = () => screen.getByRole("combobox", { name: "模型分组" });
  const choosePartner = () =>
    fireEvent.change(groupSelect(), { target: { value: "伙伴创作" } });
  const ready = async () => {
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "生成模型" })).toHaveValue(
        "gpt-image-2.5-sunburst",
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "刷新模型" })).toBeEnabled(),
    );
  };
  it("requires a group when no saved or legacy group is available, without choosing the first", async () => {
    mocks.groups.mockResolvedValue({
      groups: [{ id: "伙伴创作", description: "", ratio: 1 }],
      selectedGroup: null,
    });
    mount();
    await waitFor(() => expect(groupSelect()).toBeEnabled());
    expect(groupSelect()).toHaveValue("");
    expect(mocks.models).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
    choosePartner();
    await ready();
    expect(mocks.models).toHaveBeenCalledWith("伙伴创作");
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("does not fetch models or enable creation for an empty authorized group list", async () => {
    mocks.groups.mockResolvedValue({ groups: [], selectedGroup: null });
    mount();
    expect(await screen.findByText("暂无可用的生图或视频分组。")).toBeVisible();
    expect(mocks.models).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
  });
  it("blocks generation until the new group's catalog resolves, even if the model is cached", async () => {
    mount();
    await ready();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "scene" },
    });
    let done!: (value: typeof profiles) => void;
    mocks.models.mockImplementation((group: string) =>
      group === "伙伴创作"
        ? new Promise((r) => {
            done = r;
          })
        : Promise.resolve(profiles),
    );
    choosePartner();
    await waitFor(() => expect(groupSelect()).toHaveValue("伙伴创作"));
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    expect(mocks.submit).not.toHaveBeenCalled();
    await act(async () => done(profiles));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "生成" })).toBeEnabled(),
    );
  });
  it("shows only returned eligible groups without redundant descriptions", async () => {
    mocks.groups.mockResolvedValue({
      groups: [{ id: "生图和视频", description: "生图和视频", ratio: 1 }],
      selectedGroup: "生图和视频",
    });
    mount();
    await ready();
    expect(
      screen.getByRole("option", { name: "生图和视频" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "生图和视频 · 生图和视频" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "伙伴创作" }),
    ).not.toBeInTheDocument();
  });
  it("distinguishes unverified catalogs from an empty media catalog", async () => {
    mocks.groups.mockResolvedValue({
      groups: [],
      selectedGroup: null,
      unverifiedGroupCount: 1,
    });
    mount();
    expect(
      await screen.findByText("部分分组目录读取失败，请刷新重试。"),
    ).toBeVisible();
    expect(
      screen.queryByText("暂无可用的生图或视频分组。"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新分组" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
  });
  it("removes a saved group that no longer has media without silently switching", async () => {
    mount();
    await ready();
    choosePartner();
    await waitFor(() => expect(groupSelect()).toHaveValue("伙伴创作"));
    mocks.groups.mockResolvedValue({
      groups: [{ id: "生图和视频", description: "", ratio: 1 }],
      selectedGroup: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "刷新分组" }));
    await waitFor(() => expect(groupSelect()).toHaveValue(""));
    expect(
      screen.queryByRole("option", { name: /伙伴创作/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
  });
  it("restores the account preference and does not create a credential on mount", async () => {
    mocks.groups.mockResolvedValue({
      groups: [{ id: "伙伴创作", description: "", ratio: 1 }],
      selectedGroup: "伙伴创作",
    });
    mount();
    await ready();
    expect(groupSelect()).toHaveValue("伙伴创作");
    expect(mocks.selectGroup).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("switches the explicit submission group while preserving prompt and reference", async () => {
    mount();
    await ready();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "keep my scene" },
    });
    pasteImages([clipboardImage("group-reference")]);
    await screen.findByRole("img", { name: "参考图" });
    choosePartner();
    await waitFor(() => expect(groupSelect()).toHaveValue("伙伴创作"));
    await ready();
    expect(screen.getByRole("textbox")).toHaveValue("keep my scene");
    expect(screen.getByRole("img", { name: "参考图" })).toBeVisible();
    expect(mocks.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0][0]).toMatchObject({
      group: "伙伴创作",
      model: "gpt-image-2.5-sunburst",
      prompt: "keep my scene",
      reference: expect.stringContaining("data:image/"),
    });
  });
  it("does not silently replace a model missing in the new group", async () => {
    mount();
    await ready();
    mocks.models.mockImplementation(async (group: string) =>
      group === "伙伴创作" ? [profiles[1]] : profiles,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "keep" },
    });
    choosePartner();
    await waitFor(() => expect(groupSelect()).toHaveValue("伙伴创作"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("不会自动换模型"),
    );
    expect(screen.getByRole("combobox", { name: "生成模型" })).toHaveValue(
      "gpt-image-2.5-sunburst",
    );
    expect(screen.getByRole("textbox")).toHaveValue("keep");
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
  });
  it("ignores a late old-group catalog after the new group loads", async () => {
    mount();
    await ready();
    let finishOld!: (v: typeof profiles) => void;
    mocks.models.mockImplementation((group: string) =>
      group === "生图和视频"
        ? new Promise((r) => {
            finishOld = r;
          })
        : Promise.resolve([profiles[0]]),
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "刷新模型" })).toBeDisabled(),
    );
    choosePartner();
    await waitFor(() => expect(groupSelect()).toHaveValue("伙伴创作"));
    await ready();
    await act(async () => finishOld([profiles[1]]));
    expect(
      screen.queryByRole("option", { name: "grok-imagine-image" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "生成模型" })).toHaveValue(
      "gpt-image-2.5-sunburst",
    );
  });
  it("blocks generation and repeated switching while saving a group, then keeps the old group on failure", async () => {
    mount();
    await ready();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "scene" },
    });
    let reject!: (e: Error) => void;
    mocks.selectGroup.mockImplementation(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    choosePartner();
    choosePartner();
    expect(mocks.selectGroup).toHaveBeenCalledTimes(1);
    expect(groupSelect()).toBeDisabled();
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    expect(mocks.submit).not.toHaveBeenCalled();
    await act(async () => reject(new Error("cannot save group")));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "cannot save group",
    );
    expect(groupSelect()).toHaveValue("生图和视频");
    expect(screen.getByRole("textbox")).toHaveValue("scene");
  });
  it("fails closed if group refresh fails or selected-group permission is revoked", async () => {
    mount();
    await ready();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "scene" },
    });
    mocks.groups.mockRejectedValueOnce(new Error("group list unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "刷新分组" }));
    await screen.findByText("group list unavailable");
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
    mocks.groups.mockResolvedValue({
      groups: [{ id: "伙伴创作", description: "", ratio: 1 }],
      selectedGroup: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "刷新分组" }));
    await waitFor(() => expect(groupSelect()).toBeEnabled());
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
    expect(groupSelect()).not.toHaveValue("伙伴创作");
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("ignores an old-account group-save completion", async () => {
    const view = mount();
    await ready();
    let done!: (g: string) => void;
    mocks.selectGroup.mockImplementation(
      () =>
        new Promise((r) => {
          done = r;
        }),
    );
    choosePartner();
    mocks.account = { ...mocks.account, userId: "two" };
    view.rerender(
      <QueryClientProvider client={client}>
        <MediaStudioPage />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(groupSelect()).toBeEnabled());
    await act(async () => done("伙伴创作"));
    expect(groupSelect()).toHaveValue("生图和视频");
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("does not change group during a paid submission", async () => {
    mount();
    await ready();
    let done!: (record: MediaRecord) => void;
    mocks.submit.mockImplementation(
      () =>
        new Promise((r) => {
          done = r;
        }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "scene" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    expect(groupSelect()).toBeDisabled();
    choosePartner();
    expect(mocks.selectGroup).not.toHaveBeenCalled();
    await act(async () =>
      done(item({ status: "completed", group: "生图和视频" })),
    );
  });
  it("keeps existing video queries tied to their record after switching group", async () => {
    mocks.history.mockResolvedValue([item({ group: "生图和视频" })]);
    mount();
    await ready();
    choosePartner();
    await waitFor(() => expect(groupSelect()).toHaveValue("伙伴创作"));
    await ready();
    expect(screen.getByText("提交时的目录分组：生图和视频")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "继续查询" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledWith(item().id), {
      timeout: 4000,
    });
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

describe("P1/P2 media studio", () => {
  const enhanced = {
    ...profiles[0],
    sizes: ["1024x1024", "3840x2160"],
    qualities: ["auto", "high", "max"],
    outputFormats: ["png", "jpeg", "webp"],
    backgrounds: ["auto", "transparent"],
    customSize: true,
  };
  const video = { ...profiles[2], resolutions: ["720p"] };
  const catalog = {
    groups: [
      { id: "images", description: "", ratio: 1 },
      { id: "videos", description: "", ratio: 1 },
    ],
    selectedGroup: null,
    selectedGroups: { image: "images", video: "videos" },
    modelsByGroup: { images: [enhanced], videos: [video] },
  };
  const setup = () => {
    mocks.groups.mockResolvedValue(catalog);
    mocks.models.mockImplementation(async (g: string) =>
      g === "images" ? [enhanced] : [video],
    );
  };
  const ready = async () => {
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "生成模型" })).toHaveValue(
        enhanced.id,
      ),
    );
  };
  it("reuses the group catalog without fetching models again and filters groups by type", async () => {
    setup();
    mount();
    await ready();
    expect(mocks.models).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("option", { name: "videos" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "画面描述" }), {
      target: { value: "scene" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "画质" }), {
      target: { value: "max" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "尺寸或比例" }), {
      target: { value: "3840x2160" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "视频生成" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "模型分组" })).toHaveValue(
        "videos",
      ),
    );
    expect(
      screen.queryByRole("option", { name: "images" }),
    ).not.toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Muse时长（秒）" }),
      { target: { value: "180" } },
    );
    fireEvent.click(screen.getByRole("tab", { name: "图片生成" }));
    await ready();
    expect(screen.getByRole("combobox", { name: "画质" })).toHaveValue("max");
    expect(screen.getByRole("combobox", { name: "尺寸或比例" })).toHaveValue(
      "3840x2160",
    );
    fireEvent.click(screen.getByRole("tab", { name: "视频生成" }));
    await waitFor(() =>
      expect(
        screen.getByRole("spinbutton", { name: "Muse时长（秒）" }),
      ).toHaveValue(180),
    );
    expect(screen.getByRole("textbox", { name: "画面描述" })).toHaveValue(
      "scene",
    );
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("restores settings after reopening without storing the prompt", async () => {
    setup();
    const view = mount();
    await ready();
    fireEvent.change(screen.getByRole("combobox", { name: "画质" }), {
      target: { value: "max" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "尺寸或比例" }), {
      target: { value: "3840x2160" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "画面描述" }), {
      target: { value: "not-persisted" },
    });
    view.unmount();
    client.clear();
    mount();
    await ready();
    expect(screen.getByRole("combobox", { name: "画质" })).toHaveValue("max");
    expect(screen.getByRole("combobox", { name: "尺寸或比例" })).toHaveValue(
      "3840x2160",
    );
    expect(screen.getByRole("textbox", { name: "画面描述" })).toHaveValue("");
  });
  it("keeps changed group parameters isolated and allows removal of incompatible references", async () => {
    setup();
    mocks.groups.mockResolvedValue({
      ...catalog,
      groups: [...catalog.groups, { id: "images2", description: "", ratio: 1 }],
      modelsByGroup: { ...catalog.modelsByGroup, images2: [enhanced] },
    });
    mount();
    await ready();
    fireEvent.change(screen.getByRole("combobox", { name: "画质" }), {
      target: { value: "max" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "模型分组" }), {
      target: { value: "images2" },
    });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "模型分组" })).toHaveValue(
        "images2",
      ),
    );
    expect(screen.getByRole("combobox", { name: "画质" })).toHaveValue("auto");
    fireEvent.change(screen.getByRole("combobox", { name: "模型分组" }), {
      target: { value: "images" },
    });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "画质" })).toHaveValue("max"),
    );
  });
  it("does not choose another group for a type with no saved selection", async () => {
    setup();
    mocks.groups.mockResolvedValue({
      ...catalog,
      selectedGroups: { image: "images", video: null },
    });
    mount();
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: "视频生成" }));
    expect(screen.getByRole("combobox", { name: "模型分组" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
    expect(mocks.selectGroup).not.toHaveBeenCalled();
  });
  it("sends selected parameters with explicit local prompt consent", async () => {
    setup();
    mount();
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: "画面描述" }), {
      target: { value: "private scene" },
    });
    expect(
      screen.getByRole("checkbox", { name: "保存描述到本机以便再次编辑" }),
    ).not.toBeChecked();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "保存描述到本机以便再次编辑" }),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "画质" }), {
      target: { value: "high" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "输出格式" }), {
      target: { value: "webp" },
    });
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "压缩质量（0–100）" }),
      { target: { value: "85" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0][0]).toMatchObject({
      group: "images",
      quality: "high",
      outputFormat: "webp",
      outputCompression: 85,
      savePrompt: true,
    });
    expect(Object.values(localStorage).join("")).not.toContain("private scene");
  });
  it("restores history settings and prompt but requires references and never submits", async () => {
    setup();
    mocks.history.mockResolvedValue([
      item({
        kind: "image",
        model: enhanced.id,
        group: "images",
        status: "completed",
        draft: {
          size: "3840x2160",
          duration: null,
          quality: "max",
          outputFormat: "webp",
          prompt: "saved scene",
          needsReference: true,
        },
      }),
    ]);
    mount();
    await ready();
    fireEvent.click(await screen.findByRole("button", { name: "再次编辑" }));
    expect(screen.getByRole("textbox", { name: "画面描述" })).toHaveValue(
      "saved scene",
    );
    expect(screen.getByRole("combobox", { name: "尺寸或比例" })).toHaveValue(
      "3840x2160",
    );
    expect(screen.getByRole("combobox", { name: "画质" })).toHaveValue("max");
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
    expect(mocks.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除描述" }));
    await waitFor(() =>
      expect(mocks.forgetPrompt).toHaveBeenCalledWith(item().id),
    );
  });
  it("keeps unavailable history selections blocked instead of falling back", async () => {
    setup();
    mocks.history.mockResolvedValue([
      item({
        group: "removed",
        status: "completed",
        draft: { size: "1280x720", duration: 4, prompt: "scene" },
      }),
    ]);
    mount();
    await ready();
    fireEvent.click(await screen.findByRole("button", { name: "再次编辑" }));
    expect(screen.getByRole("combobox", { name: "模型分组" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "画面描述" })).toHaveValue(
      "scene",
    );
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

describe("inspiration gallery", () => {
  it("opens on original inspiration art and applies an authorized template without submitting", async () => {
    mount(true);
    expect(screen.getByRole("tab", { name: "灵感广场" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText(/配图为灵感示意/)).toBeVisible();
    const use = await screen.findByRole("button", {
      name: "使用 Sunburst 灵感",
    });
    await waitFor(() => expect(use).toBeEnabled());
    fireEvent.click(use);
    expect(screen.getByRole("textbox")).toHaveValue(
      MEDIA_INSPIRATION[0].prompt,
    );
    expect(screen.getByRole("combobox", { name: "生成模型" })).toHaveValue(
      "gpt-image-2.5-sunburst",
    );
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.prepareVideoReference).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("尚未提交请求");
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0][0]).toMatchObject({
      model: "gpt-image-2.5-sunburst",
      reference: null,
    });
  });
  it("keeps unavailable model cards browsable but cannot apply them", async () => {
    mount(true);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "使用 Sunburst 灵感" }),
      ).toBeEnabled(),
    );
    expect(
      screen.getByRole("button", { name: "使用 Flare 灵感" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "查看灵感：极光木屋" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("试试这样描述");
    expect(screen.getByRole("dialog")).toHaveTextContent("非模型实测结果");
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("preserves draft and reference on cancelled replacement and clears only after confirmation", async () => {
    mount();
    await screen.findByRole("button", { name: "上传参考图（可选）" });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "my draft" },
    });
    pasteImages([clipboardImage("my-image")]);
    await screen.findByRole("img", { name: "参考图" });
    fireEvent.click(screen.getByRole("tab", { name: "灵感广场" }));
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "使用 Sunburst 灵感" }));
    expect(screen.getByRole("tab", { name: "灵感广场" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(screen.getByRole("tab", { name: "创作工作台" }));
    expect(screen.getByRole("textbox")).toHaveValue("my draft");
    expect(screen.getByRole("img", { name: "参考图" })).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "灵感广场" }));
    fireEvent.click(screen.getByRole("button", { name: "使用 Sunburst 灵感" }));
    expect(
      screen.queryByRole("img", { name: "参考图" }),
    ).not.toBeInTheDocument();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("keeps video creation available without presenting static images as video samples", async () => {
    mount(true);
    fireEvent.click(screen.getByRole("button", { name: "镜头灵感" }));
    expect(screen.getByText("视频灵感准备中")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "使用 Muse 灵感" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "使用 Sunburst 灵感" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "前往创作工作台" }));
    fireEvent.click(screen.getByRole("tab", { name: "视频生成" }));
    await screen.findByRole("combobox", { name: "生成模型" });
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("shows artwork at its intrinsic ratio and preserves the whole portrait in details", () => {
    mount(true);
    const portrait = screen.getByRole("img", { name: "插画 · 自然想象" });
    expect(portrait).toHaveAttribute("width", "1350");
    expect(portrait).toHaveAttribute("height", "2400");
    fireEvent.click(screen.getByRole("button", { name: "查看灵感：云端山谷" }));
    expect(screen.getByRole("dialog").querySelector("img")).toHaveClass(
      "object-contain",
    );
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("does not replace a draft during submission even after navigating to gallery", async () => {
    let done!: (record: MediaRecord) => void;
    mocks.submit.mockImplementation(
      () =>
        new Promise((r) => {
          done = r;
        }),
    );
    mount();
    await screen.findByRole("button", { name: "上传参考图（可选）" });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "busy draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    fireEvent.click(screen.getByRole("tab", { name: "灵感广场" }));
    expect(
      screen.getByRole("button", { name: "使用 Sunburst 灵感" }),
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "切换视图不会取消任务",
    );
    await act(async () => done(item({ status: "completed" })));
    fireEvent.click(screen.getByRole("tab", { name: "创作工作台" }));
    expect(screen.getByRole("textbox")).toHaveValue("busy draft");
  });
  it("fails closed when the model directory errors and retains manual refresh", async () => {
    mocks.models.mockRejectedValue(new Error("catalog failed"));
    mount(true);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "模型目录读取失败",
    );
    expect(
      screen.getByRole("button", { name: "使用 Sunburst 灵感" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "开始创作" }));
    expect(screen.getByRole("button", { name: "刷新模型" })).toBeEnabled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

describe("reference image paste", () => {
  it("appends GPT clipboard images and submits only on Generate", async () => {
    mount();
    await screen.findByRole("button", { name: "上传参考图（可选）" });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "existing prompt" },
    });
    expect(pasteImages([clipboardImage("first")])).toBe(false);
    expect(await screen.findByRole("img", { name: "参考图" })).toHaveAttribute(
      "src",
      `data:image/png;base64,${btoa("first")}`,
    );
    pasteImages([clipboardImage("second")], true);
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "参考图 2" })).toHaveAttribute(
        "src",
        `data:image/png;base64,${btoa("second")}`,
      ),
    );
    expect(screen.getByRole("textbox")).toHaveValue("existing prompt");
    expect(mocks.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0][0]).toMatchObject({
      reference: null,
      images: [
        `data:image/png;base64,${btoa("first")}`,
        `data:image/png;base64,${btoa("second")}`,
      ],
    });
  });
  it("accepts sixteen GPT references via upload/paste and retains them when switching to Muse", async () => {
    mount();
    await screen.findByRole("button", { name: "上传参考图（可选）" });
    const files = Array.from({ length: 15 }, (_, i) =>
      clipboardImage(String(i)),
    );
    fireEvent.change(screen.getByLabelText("选择参考图"), {
      target: { files },
    });
    await screen.findByRole("img", { name: "参考图 15" });
    pasteImages([clipboardImage("last", "image/webp")]);
    await screen.findByRole("img", { name: "参考图 16" });
    const rejected = clipboardImage("seventeenth");
    pasteImages([rejected]);
    expect(rejected.arrayBuffer).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("16");
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "scene" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "视频生成" }));
    await screen.findByRole("option", { name: "muse-video" });
    await waitFor(() =>
      expect(screen.getByLabelText("选择参考图")).toHaveAttribute(
        "accept",
        "image/png,image/jpeg,image/webp",
      ),
    );
    expect(screen.getByRole("img", { name: "参考图 16" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("原图已保留");
    fireEvent.click(screen.getByRole("tab", { name: "图片生成" }));
    await screen.findByRole("button", { name: "上传参考图（可选）" });
    fireEvent.click(screen.getAllByRole("button", { name: "前移" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0][0].images).toHaveLength(16);
    expect(mocks.submit.mock.calls[0][0].images[0]).toBe(
      `data:image/png;base64,${btoa("1")}`,
    );
  });
  it("leaves text and HTML-only clipboard events to the editor", async () => {
    mount();
    await screen.findByRole("button", { name: "上传参考图（可选）" });
    expect(
      fireEvent.paste(screen.getByRole("textbox"), {
        clipboardData: {
          files: [],
          items: [{ kind: "string", type: "text/html" }],
          getData: () => '<img src="https://example.com/image.png">',
        },
      }),
    ).toBe(true);
    expect(
      screen.queryByRole("img", { name: "参考图" }),
    ).not.toBeInTheDocument();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("appends Muse clipboard images in order, without duplicating files and items", async () => {
    mount();
    await screen.findByRole("button", { name: "上传参考图（可选）" });
    fireEvent.click(screen.getByRole("tab", { name: "视频生成" }));
    await screen.findByRole("option", { name: "muse-video" });
    await waitFor(() =>
      expect(screen.getByLabelText("选择参考图")).toHaveAttribute(
        "accept",
        "image/png,image/jpeg,image/webp",
      ),
    );
    pasteImages([clipboardImage("one")]);
    await screen.findByRole("img", { name: "参考图" });
    pasteImages([clipboardImage("two", "image/webp"), clipboardImage("three")]);
    await screen.findByRole("img", { name: "参考图 3" });
    expect(
      screen.queryByRole("img", { name: "参考图 4" }),
    ).not.toBeInTheDocument();
    const excess = clipboardImage("excess");
    pasteImages([excess, excess]);
    expect(screen.getByRole("status")).toHaveTextContent("最多支持 4 张");
    expect(excess.arrayBuffer).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "move" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0][0].images).toEqual([
      `data:image/png;base64,${btoa("one")}`,
      `data:image/webp;base64,${btoa("two")}`,
      `data:image/png;base64,${btoa("three")}`,
    ]);
  });
  it("preserves the draft on unsupported formats or oversize clipboard images", async () => {
    mount();
    await screen.findByRole("button", { name: "上传参考图（可选）" });
    pasteImages([clipboardImage("keep")]);
    await screen.findByRole("img", { name: "参考图" });
    const invalid = clipboardImage("bad", "image/gif");
    const large = clipboardImage("large");
    Object.defineProperty(large, "size", { value: 50 * 1024 * 1024 });
    for (const file of [invalid, large]) {
      pasteImages([file]);
      expect(screen.getByRole("status")).toHaveTextContent("50MB");
      expect(file.arrayBuffer).not.toHaveBeenCalled();
      expect(screen.getByRole("img", { name: "参考图" })).toHaveAttribute(
        "src",
        `data:image/png;base64,${btoa("keep")}`,
      );
    }
  });
  it("blocks paste for text-only models and during submission", async () => {
    mount();
    await screen.findByRole("button", { name: "上传参考图（可选）" });
    fireEvent.change(screen.getByRole("combobox", { name: "生成模型" }), {
      target: { value: "grok-imagine-image" },
    });
    const image = clipboardImage("blocked");
    pasteImages([image]);
    expect(screen.getByRole("status")).toHaveTextContent(
      "当前模型无法添加参考图",
    );
    fireEvent.change(screen.getByRole("combobox", { name: "生成模型" }), {
      target: { value: "gpt-image-2.5-sunburst" },
    });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "test" },
    });
    let finish!: (record: MediaRecord) => void;
    mocks.submit.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    pasteImages([image]);
    expect(image.arrayBuffer).not.toHaveBeenCalled();
    await act(async () => finish(item({ status: "failed" })));
  });
  it("does not cancel an in-flight read on rapid paste and recovers after read failure", async () => {
    mount();
    await screen.findByRole("button", { name: "上传参考图（可选）" });
    let reject!: (reason: Error) => void;
    const slow = clipboardImage("slow");
    Object.defineProperty(slow, "arrayBuffer", {
      value: () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    });
    pasteImages([slow]);
    const next = clipboardImage("next");
    pasteImages([next]);
    expect(next.arrayBuffer).not.toHaveBeenCalled();
    await act(async () => reject(new Error("unreadable")));
    expect(screen.getByRole("status")).toHaveTextContent("读取参考图失败");
    pasteImages([next]);
    await screen.findByRole("img", { name: "参考图" });
  });
  it.each(["account", "model"])(
    "discards a delayed clipboard read after changing %s",
    async (change) => {
      const view = mount();
      await screen.findByRole("button", { name: "上传参考图（可选）" });
      let resolve!: (data: ArrayBuffer) => void;
      const slow = clipboardImage("slow");
      Object.defineProperty(slow, "arrayBuffer", {
        value: () =>
          new Promise((done) => {
            resolve = done;
          }),
      });
      pasteImages([slow]);
      if (change === "account") {
        mocks.account = { ...mocks.account, userId: "two" };
        view.rerender(
          <QueryClientProvider client={client}>
            <MediaStudioPage />
          </QueryClientProvider>,
        );
        fireEvent.click(screen.getByRole("tab", { name: "创作工作台" }));
        await screen.findByRole("button", { name: "上传参考图（可选）" });
      } else {
        fireEvent.change(screen.getByRole("combobox", { name: "生成模型" }), {
          target: { value: "grok-imagine-image" },
        });
      }
      await act(async () =>
        resolve(new TextEncoder().encode("old-account").buffer),
      );
      expect(
        screen.queryByRole("img", { name: "参考图" }),
      ).not.toBeInTheDocument();
      expect(mocks.submit).not.toHaveBeenCalled();
    },
  );
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
    expect(screen.getByRole("status")).toHaveTextContent("最多支持 4 张");
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
    expect(screen.getByRole("img", { name: "参考图" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("原图已保留");
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
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
  it("shows the selected group and supported catalog without submitting on mount", async () => {
    mount();
    expect(
      await screen.findByRole("option", { name: "gpt-image-2.5-sunburst" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "模型分组" })).toHaveValue(
      "生图和视频",
    );
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
    expect(mocks.submit.mock.calls[0][0]).toHaveProperty("group", "生图和视频");
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
    expect(screen.getByRole("tab", { name: "灵感广场" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(screen.getByRole("tab", { name: "创作工作台" }));
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
