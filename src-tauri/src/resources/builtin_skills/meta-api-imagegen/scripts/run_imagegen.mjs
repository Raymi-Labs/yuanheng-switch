#!/usr/bin/env node

// Every installed copy binds to its own stable runtime path. ZIP-imported copies
// retain that binding while YuanHeng refreshes the local Core port independently.
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const TARGETS = new Set([
  "claude",
  "codex",
  "gemini",
  "grokbuild",
  "opencode",
  "hermes",
  "dsh",
  "workbuddy",
]);

async function readManagedJson(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error(
      `${label} is missing; enable this image skill for the current tool in YuanHeng`,
    );
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 16 * 1024
  )
    throw new Error(`Invalid ${label} file`);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Invalid ${label} JSON`);
  }
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const binding = await readManagedJson(
    resolve(scriptDir, "..", "yuanheng-binding.json"),
    "YuanHeng image binding",
  );
  if (
    !binding ||
    binding.owner !== "yuanheng-imagegen" ||
    binding.version !== 1 ||
    !TARGETS.has(binding.target) ||
    typeof binding.runtimePath !== "string" ||
    !isAbsolute(binding.runtimePath) ||
    /^(?:\\\\|\/\/)/.test(binding.runtimePath) ||
    Object.keys(binding).some(
      (key) => !["owner", "version", "target", "runtimePath"].includes(key),
    )
  )
    throw new Error(
      "Invalid YuanHeng image binding; re-enable this skill in YuanHeng",
    );
  // OpenCode also discovers Claude skills. Its shell sets OPENCODE=1, so a
  // discovered sibling copy must never borrow that sibling's account or route.
  if (process.env.OPENCODE === "1" && binding.target !== "opencode")
    throw new Error(
      "This image skill belongs to another tool; enable and use the OpenCode image skill in YuanHeng. Start other tools in an independent session.",
    );
  const args = process.argv.slice(2);
  if (args.includes("--runtime") || args.includes("--surface"))
    throw new Error(
      "The installed skill selects its own runtime and surface; use the target tool's skill",
    );
  let surface = binding.target;
  const direct = args.includes("--api-key") || args.includes("--base-url");
  if (binding.target === "codex") {
    const environmentSurface = process.env.YUANHENG_IMAGEGEN_SURFACE;
    if (
      environmentSurface &&
      !["codex", "chatgpt-desktop"].includes(environmentSurface)
    )
      throw new Error("Unknown Codex image surface");
    if (environmentSurface) surface = environmentSurface;
    else if (!direct) {
      const runtime = await readManagedJson(
        binding.runtimePath,
        "YuanHeng image runtime",
      );
      if (
        runtime?.target !== "codex" ||
        !["codex", "chatgpt-desktop"].includes(runtime.defaultSurface)
      )
        throw new Error(
          "Image runtime does not belong to the Codex tool group",
        );
      surface = runtime.defaultSurface;
    }
  }
  // Explicit surface also isolates other tools from inherited Codex environment.
  const child = spawn(
    process.execPath,
    [
      resolve(scriptDir, "meta_api_imagegen.mjs"),
      ...args,
      "--runtime",
      binding.runtimePath,
      "--surface",
      surface,
    ],
    { stdio: "inherit" },
  );
  const forwardInterrupt = () => child.kill("SIGINT");
  const forwardTerminate = () => child.kill("SIGTERM");
  process.on("SIGINT", forwardInterrupt);
  process.on("SIGTERM", forwardTerminate);
  child.on("error", () => {
    console.error("ERROR=Unable to start the image helper");
    process.exitCode = 1;
  });
  child.on("close", (code) => {
    process.removeListener("SIGINT", forwardInterrupt);
    process.removeListener("SIGTERM", forwardTerminate);
    process.exitCode = code ?? 1;
  });
}

main().catch((error) => {
  console.error(`ERROR=${error.message}`);
  process.exitCode = 1;
});
