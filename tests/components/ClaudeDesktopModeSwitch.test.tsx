import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClaudeDesktopModeSwitch } from "@/components/desktop/ClaudeDesktopModeSwitch";

describe("Claude Desktop account mode", () => {
  it("shows native login guidance and preserves an explicit relay return", () => {
    const control = {
      data: {
        mode: "official" as const,
        yuanhengAvailable: true,
        restartRequired: true,
      },
      pending: false,
      error: false,
      setupRequested: false,
      switchMode: vi.fn(),
      refetch: vi.fn(),
    };
    render(<ClaudeDesktopModeSwitch control={control} />);
    expect(screen.getByRole("button", { name: "Claude 官方" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText(/切换模式不会替你登录账号/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "元衡中转" }));
    expect(control.switchMode).toHaveBeenCalledWith("yuanheng");
  });
  it("blocks mode changes while configuration is pending", () => {
    const control = {
      data: {
        mode: "yuanheng" as const,
        yuanhengAvailable: true,
        restartRequired: false,
      },
      pending: true,
      error: false,
      setupRequested: false,
      switchMode: vi.fn(),
      refetch: vi.fn(),
    };
    render(<ClaudeDesktopModeSwitch control={control} dark />);
    expect(screen.getByRole("button", { name: "Claude 官方" })).toBeDisabled();
  });
});
