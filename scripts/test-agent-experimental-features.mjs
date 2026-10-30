import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agentExperimentalFeatures } from "./agent-experimental-features.mjs";

test("default and legacy environment settings enable the same feature on every release platform", () => {
  for (const target of [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
  ]) {
    for (const env of [
      {},
      { VITE_ENABLE_ACCIO_WORK: "0" },
      { VITE_ENABLE_ACCIO_WORK: "true" },
    ]) {
      assert.deepEqual(agentExperimentalFeatures(env, target, "release"), [
        "accio-work-experimental",
      ]);
    }
  }
});
test("release and development builds include Accio without claiming runtime compatibility", () => {
  const env = { VITE_ENABLE_ACCIO_WORK: "1" };
  assert.deepEqual(
    agentExperimentalFeatures(env, "aarch64-apple-darwin", "release"),
    ["accio-work-experimental"],
  );
  for (const target of [
    undefined,
    "",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "aarch64-unknown-linux-gnu",
  ]) {
    for (const profile of ["release", "debug"]) {
      assert.deepEqual(agentExperimentalFeatures(env, target, profile), [
        "accio-work-experimental",
      ]);
    }
  }
});
test("release orchestration passes the same feature decision to UI and Core", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /VITE_ENABLE_ACCIO_WORK: \$\{\{ matrix\.accio_enabled \}\}/,
  );
  assert.match(
    workflow,
    /args: --target \$\{\{ matrix\.target \}\} --bundles \$\{\{ matrix\.bundles \}\} \$\{\{ matrix\.feature_args \}\}/,
  );
  assert.match(
    workflow,
    /target: aarch64-apple-darwin\s+bundles: app,dmg\s+accio_enabled: "1"\s+feature_args: "--features accio-work-experimental"/,
  );
  assert.match(
    workflow,
    /target: x86_64-apple-darwin\s+bundles: app,dmg\s+accio_enabled: "1"\s+feature_args: "--features accio-work-experimental"/,
  );
  assert.match(
    workflow,
    /target: x86_64-pc-windows-msvc\s+bundles: nsis\s+accio_enabled: "1"\s+feature_args: "--features accio-work-experimental"/,
  );
  const cargo = readFileSync(
    new URL("../src-tauri/Cargo.toml", import.meta.url),
    "utf8",
  );
  assert.match(cargo, /default = \["accio-work-experimental"\]/);
});
