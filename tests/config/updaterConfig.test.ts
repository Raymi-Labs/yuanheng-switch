import tauriConfig from "../../src-tauri/tauri.conf.json";

const githubReleaseManifest =
  "https://github.com/Raymi-Labs/yuanheng-switch/releases/latest/download/latest.json";
const yuanHengReleaseManifest =
  "https://meta-api.vip/desktop/update/latest.json";

describe("desktop updater config", () => {
  it("uses the YuanHeng mirror as the primary endpoint", () => {
    expect(tauriConfig.plugins.updater.endpoints[0]).toBe(
      yuanHengReleaseManifest,
    );
  });

  it("keeps GitHub releases as the fallback endpoint", () => {
    expect(tauriConfig.plugins.updater.endpoints[1]).toBe(
      githubReleaseManifest,
    );
  });
});
