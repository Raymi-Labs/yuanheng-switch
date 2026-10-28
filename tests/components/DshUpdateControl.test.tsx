import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DshUpdateControl } from "@/components/desktop/DshUpdateControl";
const api = vi.hoisted(() => ({
  getToolVersions: vi.fn(),
  runToolLifecycleAction: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ settingsApi: api }));
describe("DSH desktop updates", () => {
  it("shows the installed desktop version without comparing npm or installing Web", () => {
    render(<DshUpdateControl version="0.2.1-rc.3" />);
    expect(screen.getByText("当前版本 0.2.1-rc.3")).toBeInTheDocument();
    expect(
      screen.getByText("请在 DSH 桌面端菜单中检查更新。"),
    ).toBeInTheDocument();
    expect(api.getToolVersions).not.toHaveBeenCalled();
    expect(api.runToolLifecycleAction).not.toHaveBeenCalled();
  });
});
