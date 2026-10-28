import { execFileSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentExperimentalFeatures } from "./agent-experimental-features.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cargoDir = join(root, "src-tauri");
const profile = process.argv[2] === "release" ? "release" : "debug";
const rustcInfo = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const hostTarget = rustcInfo.match(/^host:\s*(.+)$/m)?.[1]?.trim();
const requestedTarget = process.env.YUANHENG_BUILD_TARGET?.trim();
const target = requestedTarget || hostTarget;

if (!target) {
  throw new Error("无法从 rustc -vV 获取目标三元组");
}
const experimentalFeatures = agentExperimentalFeatures(
  process.env,
  target,
  profile,
);

const isWindowsTarget = target.includes("windows");
const executable = isWindowsTarget ? "yuanheng-core.exe" : "yuanheng-core";
const source = requestedTarget
  ? join(cargoDir, "target", target, profile, executable)
  : join(cargoDir, "target", profile, executable);
const suffix = isWindowsTarget ? ".exe" : "";
const destination = join(
  cargoDir,
  "binaries",
  `yuanheng-core-${target}${suffix}`,
);

mkdirSync(dirname(destination), { recursive: true });
// Tauri validates externalBin before Cargo can build the sidecar on a clean checkout.
if (!existsSync(destination)) {
  closeSync(openSync(destination, "w"));
}

const cargoArgs = ["build", "--bin", "yuanheng-core"];
if (experimentalFeatures.length) {
  cargoArgs.push("--features", experimentalFeatures.join(","));
}
if (profile === "release") {
  cargoArgs.push("--release");
}
if (requestedTarget) {
  cargoArgs.push("--target", target);
}

execFileSync("cargo", cargoArgs, {
  cwd: cargoDir,
  stdio: "inherit",
});

copyFileSync(source, destination);
console.log(`Prepared Core sidecar: ${destination}`);
