import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agentExperimentalFeatures } from "./agent-experimental-features.mjs";

test("ordinary builds preserve the existing feature set on all release platforms", () => {
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
      assert.deepEqual(agentExperimentalFeatures(env, target, "release"), []);
    }
  }
});
test("an explicit experimental release is limited to the verified architecture", () => {
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
    assert.throws(
      () => agentExperimentalFeatures(env, target, "release"),
      /Apple Silicon/,
    );
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
    /target: x86_64-apple-darwin\s+bundles: app,dmg\s+accio_enabled: "0"\s+feature_args: ""/,
  );
  assert.match(
    workflow,
    /target: x86_64-pc-windows-msvc\s+bundles: nsis\s+accio_enabled: "0"\s+feature_args: ""/,
  );
});
