import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccioCommerceGuide,
  COMMERCE_FIRST,
  COMMERCE_REVISION,
} from "@/components/desktop/AccioCommerceGuide";
import { AccioConnectionNotice } from "@/components/desktop/AccioConnectionNotice";
const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  prepare: vi.fn(),
  check: vi.fn(),
  copy: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ settingsApi: { pickDirectory: mocks.pick } }));
vi.mock("@/lib/api/accio-commerce", () => ({
  accioCommerceApi: { prepare: mocks.prepare, check: mocks.check },
}));
vi.mock("@/lib/clipboard", () => ({ copyText: mocks.copy }));
vi.mock("@/components/desktop/AccioReleaseNotice", () => ({
  AccioReleaseNotice: () => null,
}));
const report = (passed = true, baselineSaved = false) => ({
  passed,
  baselineSaved,
  productCount: 6,
  requiresHumanReview: true,
  nativeExecutionVerified: false,
  errors: passed ? [] : ["source facts changed"],
});
async function open() {
  render(<AccioCommerceGuide />);
  fireEvent.click(screen.getByRole("button", { name: "商品文案示例" }));
}
async function prepare() {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "创建示例任务文件夹" }));
  await screen.findByText(/任务根目录/);
}
describe("Accio commerce guide", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pick.mockResolvedValue("/中文资料");
    mocks.prepare.mockResolvedValue({
      root: "/中文资料/Accio样例",
      work: "/中文资料/Accio样例/work",
    });
    mocks.check.mockResolvedValue(report());
    mocks.copy.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  it("only Accio supported tool shows entry", () => {
    const { rerender } = render(
      <AccioConnectionNotice
        status={{ app: "codex", supported: true } as any}
      />,
    );
    expect(screen.queryByText("商品文案示例")).not.toBeInTheDocument();
    rerender(
      <AccioConnectionNotice
        status={{ app: "accio-work", supported: false } as any}
      />,
    );
    expect(screen.queryByText("商品文案示例")).not.toBeInTheDocument();
    rerender(
      <AccioConnectionNotice
        status={{ app: "accio-work", supported: true } as any}
      />,
    );
    expect(screen.getByText("商品文案示例")).toBeInTheDocument();
  });
  it("canceled directory picker never creates or checks files", async () => {
    mocks.pick.mockResolvedValue(null);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "创建示例任务文件夹" }));
    await waitFor(() => expect(mocks.pick).toHaveBeenCalledOnce());
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.check).not.toHaveBeenCalled();
  });
  it("full explicit workflow copies instructions but never auto submits", async () => {
    await prepare();
    expect(mocks.prepare).toHaveBeenCalledWith("/中文资料");
    expect(screen.getByRole("button", { name: "保存初稿基线" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "复制修订指令" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "复制第一阶段指令" }));
    await waitFor(() =>
      expect(mocks.copy).toHaveBeenCalledWith(COMMERCE_FIRST),
    );
    fireEvent.click(screen.getByRole("button", { name: "检查初稿" }));
    await screen.findByText("文件规则检查通过，仍需人工审稿");
    mocks.check.mockResolvedValue(report(true, true));
    fireEvent.click(screen.getByRole("button", { name: "保存初稿基线" }));
    await screen.findByText("已保留初稿基线，不会覆盖");
    expect(mocks.check).toHaveBeenCalledWith("/中文资料/Accio样例", "snapshot");
    expect(screen.getByRole("button", { name: "保存初稿基线" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "复制修订指令" }));
    await waitFor(() =>
      expect(mocks.copy).toHaveBeenCalledWith(COMMERCE_REVISION),
    );
    fireEvent.click(screen.getByRole("button", { name: "检查修订" }));
    await waitFor(() =>
      expect(mocks.check).toHaveBeenCalledWith(
        "/中文资料/Accio样例",
        "revision",
      ),
    );
  });
  it("failed draft cannot snapshot and failed recheck clears old success", async () => {
    await prepare();
    fireEvent.click(screen.getByRole("button", { name: "检查初稿" }));
    await screen.findByText("文件规则检查通过，仍需人工审稿");
    mocks.check.mockRejectedValue(new Error("file missing"));
    fireEvent.click(screen.getByRole("button", { name: "检查初稿" }));
    await screen.findByRole("alert");
    expect(
      screen.queryByText("文件规则检查通过，仍需人工审稿"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存初稿基线" })).toBeDisabled();
  });
  it("rapid create clicks are single-flight and canceled confirmation does not save", async () => {
    let resolve!: (value: string) => void;
    mocks.pick.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    await open();
    const button = screen.getByRole("button", { name: "创建示例任务文件夹" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.pick).toHaveBeenCalledOnce();
    await act(async () => {
      resolve("/中文资料");
    });
    await screen.findByText(/任务根目录/);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "检查初稿" }));
    await screen.findByText("文件规则检查通过，仍需人工审稿");
    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "保存初稿基线" }));
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });
  it("choosing another task clears prior results and does not create files", async () => {
    await prepare();
    fireEvent.click(screen.getByRole("button", { name: "检查初稿" }));
    await screen.findByText("文件规则检查通过，仍需人工审稿");
    mocks.pick.mockResolvedValue("/another");
    fireEvent.click(screen.getByRole("button", { name: "选择已有任务" }));
    await screen.findByText(/任务根目录.*another/);
    expect(
      screen.queryByText("文件规则检查通过，仍需人工审稿"),
    ).not.toBeInTheDocument();
    expect(mocks.prepare).toHaveBeenCalledOnce();
  });
});
