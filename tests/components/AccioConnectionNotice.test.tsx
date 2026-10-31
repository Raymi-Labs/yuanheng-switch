import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/components/desktop/AccioReleaseNotice", () => ({
  AccioReleaseNotice: () => <p>official release check</p>,
}));
import type { YuanhengToolStatus } from "@/lib/api";
import { AccioConnectionNotice } from "@/components/desktop/AccioConnectionNotice";

const status: YuanhengToolStatus = {
  app: "accio-work",
  supported: true,
  configured: true,
  needsUpdate: false,
  model: "sol",
  recommendedModel: "sol",
  message: null,
};
describe("AccioConnectionNotice", () => {
  it("shows installed and verified versions before configuring an unknown version", () => {
    render(
      <AccioConnectionNotice
        status={{
          ...status,
          accioCompatibility: {
            installedVersion: "0.38.0",
            supportedVersions: ["0.37.1"],
            state: "unverified_version",
          },
        }}
      />,
    );
    expect(screen.getByText(/已安装 Accio：0.38.0/)).toBeVisible();
    expect(screen.getByText(/元衡已验证版本：0.37.1/)).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("配置和启动暂不可用");
    expect(screen.getByText("official release check")).toBeVisible();
  });
  it("explains saved configuration, controlled launch and native model selection", () => {
    render(<AccioConnectionNotice status={status} />);
    expect(
      screen.getByText(/普通打开 Accio 不会自动走元衡/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Auto 使用该模型/)).toBeInTheDocument();
  });
  it("keeps incompatibility visible before configuration or launch", () => {
    render(
      <AccioConnectionNotice
        status={{ ...status, runtimeWarning: "此版本未验证，原配置未更改" }}
        dark
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("此版本未验证");
  });
  it("does not change other agents", () => {
    const { container } = render(
      <AccioConnectionNotice status={{ ...status, app: "codex" }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
  it("explains unsupported platforms without instructing users to configure or launch", () => {
    render(
      <AccioConnectionNotice
        status={{ ...status, supported: false, configured: false }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "暂不支持元衡配置和启动",
    );
    expect(screen.queryByText(/配置保存后/)).not.toBeInTheDocument();
  });
});
