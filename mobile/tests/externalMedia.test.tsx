import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Voice } from "../src/Voice";
import { Images } from "../src/Images";
import { MaskEditor } from "../src/MaskEditor";
import { api } from "../src/api";
vi.mock("../src/App", () => ({
  Notice: ({ text }: { text: string }) => <p>{text}</p>,
}));
vi.mock("../src/api", async (original) => ({
  ...(await original<typeof import("../src/api")>()),
  api: {
    tts: vi.fn(),
    cancel: vi.fn(),
    get: vi.fn(),
    galleryList: vi.fn(),
    gallerySave: vi.fn(),
    galleryDelete: vi.fn(),
    image: vi.fn(),
  },
}));
const readers: Array<{
  result: string;
  onload?: () => void;
  abort: () => void;
}> = [];
beforeEach(() => {
  vi.clearAllMocks();
  readers.length = 0;
  vi.mocked(api.get).mockResolvedValue(["gpt-image-2"]);
  vi.mocked(api.galleryList).mockResolvedValue([]);
  vi.mocked(api.cancel).mockResolvedValue(undefined);
  vi.stubGlobal(
    "FileReader",
    class {
      result = "data:audio/wav;base64,UklGRjAwMDBXQVZF";
      onload?: () => void;
      onerror?: () => void;
      abort = vi.fn();
      constructor() {
        readers.push(this);
      }
      readAsDataURL(file: File) {
        this.result =
          file.type === "image/png"
            ? "data:image/png;base64,iVBORw0KGgo="
            : this.result;
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("external mobile media safety", () => {
  it("requires voice authorization, submits once and cancels on unmount", async () => {
    vi.mocked(api.tts).mockReturnValue(new Promise(() => {}));
    const v = render(<Voice userId={7} />);
    fireEvent.change(screen.getByLabelText("上传声音样本"), {
      target: { files: [new File(["x"], "voice.wav", { type: "audio/wav" })] },
    });
    act(() => readers[0].onload?.());
    fireEvent.change(
      screen.getByPlaceholderText("输入要让克隆声音朗读的文本…"),
      { target: { value: "hello" } },
    );
    fireEvent.click(screen.getByText("生成语音"));
    expect(api.tts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("生成语音"));
    expect(api.tts).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.tts).mock.calls[0].slice(1)).toEqual([
      "hello",
      "UklGRjAwMDBXQVZF",
      "",
      true,
      7,
      "",
    ]);
    v.unmount();
    expect(api.cancel).toHaveBeenCalledWith(
      vi.mocked(api.tts).mock.calls[0][0],
    );
  });
  it("ignores a late replaced voice sample", async () => {
    render(<Voice userId={7} />);
    const input = screen.getByLabelText("上传声音样本");
    for (const name of ["old.wav", "new.wav"])
      fireEvent.change(input, {
        target: { files: [new File(["x"], name, { type: "audio/wav" })] },
      });
    act(() => {
      readers[1].onload?.();
      readers[0].onload?.();
    });
    expect(screen.getByText(/new.wav/)).toBeTruthy();
    expect(screen.queryByText(/old.wav/)).toBeNull();
    await act(async () => {});
  });
  it("sends multiple references and retains account binding when favoriting", async () => {
    vi.mocked(api.image).mockResolvedValue({
      data: "iVBORw0KGgo=",
      mime: "image/png",
    });
    vi.mocked(api.gallerySave).mockResolvedValue(undefined);
    render(<Images userId={7} active refresh={async () => {}} />);
    for (let i = 0; i < 2; i++) {
      fireEvent.change(screen.getByLabelText("上传参考图"), {
        target: { files: [new File(["x"], `${i}.png`, { type: "image/png" })] },
      });
      act(() => readers[i].onload?.());
    }
    fireEvent.change(screen.getByLabelText("画面描述"), {
      target: { value: "synthetic" },
    });
    fireEvent.click(screen.getByText("生成图片"));
    await waitFor(() => expect(api.image).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.image).mock.calls[0][5]).toEqual([
      "iVBORw0KGgo=",
      "iVBORw0KGgo=",
    ]);
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "收藏" }).length,
      ).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "收藏" })[0]);
    await waitFor(() => expect(api.gallerySave).toHaveBeenCalled());
    expect(vi.mocked(api.gallerySave).mock.calls[0][1]).toBe(7);
    expect(vi.mocked(api.gallerySave).mock.calls[0][0].references).toEqual([
      "data:image/png;base64,iVBORw0KGgo=",
    ]);
  });
  it("refuses oversized mask canvases before allocation", () => {
    render(
      <MaskEditor
        source={{ data: "x", mime: "image/png" }}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const img = screen.getByAltText("遮罩底图");
    Object.defineProperty(img, "naturalWidth", { value: 10000 });
    Object.defineProperty(img, "naturalHeight", { value: 10000 });
    fireEvent.load(img);
    expect(screen.getByText(/像素过大/)).toBeTruthy();
  });
});
