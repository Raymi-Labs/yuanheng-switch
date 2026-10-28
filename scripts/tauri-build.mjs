import { execFileSync } from "node:child_process";
import { agentExperimentalFeatures } from "./agent-experimental-features.mjs";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const args = ["tauri", "build"];
const hostTarget = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
  .match(/^host:\s*(.+)$/m)?.[1]
  ?.trim();
const features = agentExperimentalFeatures(
  process.env,
  process.env.YUANHENG_BUILD_TARGET?.trim() || hostTarget,
  "release",
);
if (features.length) args.push("--features", features.join(","));
const config = {
  build: {
    // Core 已在 Tauri 读取 externalBin 前生成，这里只需构建前端。
    beforeBuildCommand: "pnpm run build:renderer",
  },
};

execFileSync(
  process.execPath,
  ["scripts/prepare-core-sidecar.mjs", "release"],
  {
    stdio: "inherit",
    env: process.env,
  },
);

if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  console.log("未配置 Tauri 更新签名私钥，本地构建将跳过 updater artifacts。");
  config.bundle = {
    createUpdaterArtifacts: false,
  };
}

args.push("--config", JSON.stringify(config));

execFileSync(pnpm, args, {
  stdio: "inherit",
  env: process.env,
});
