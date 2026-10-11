import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform === "win32")(
  "real POSIX installer rejection paths",
  () => {
    it.each(["download", "checksum"])(
      "stops at %s and never extracts or executes rejected bytes",
      (phase) => {
        const root = mkdtempSync(join(tmpdir(), "yuanheng-dsh-rejected-"));
        try {
          const bin = join(root, "fake-bin");
          mkdirSync(bin);
          const fake = (name: string, text: string) =>
            writeFileSync(join(bin, name), `#!/bin/sh\n${text}\n`, {
              mode: 0o700,
            });
          fake(
            "uname",
            'if [ "$1" = "-s" ]; then echo Darwin; else echo arm64; fi',
          );
          fake(
            "curl",
            phase === "download"
              ? "exit 22"
              : "echo 'unexpected response' > runtime.tar.gz",
          );
          fake("shasum", "echo '0000 runtime.tar.gz'");
          fake("tar", 'touch "$YUANHENG_DSH_STAGE/EXECUTED"; exit 99');
          fake("node", 'touch "$YUANHENG_DSH_STAGE/EXECUTED"; exit 99');
          const result = spawnSync(
            "/bin/bash",
            [resolve("src-tauri/scripts/install-dsh.sh")],
            {
              env: {
                ...process.env,
                PATH: `${bin}:/usr/bin:/bin`,
                YUANHENG_DSH_STAGE: root,
              },
              timeout: 5000,
            },
          );
          expect(result.status).not.toBe(0);
          expect(result.error).toBeUndefined();
          expect(readFileSync(join(root, "phase"), "utf8").trim()).toBe(phase);
          expect(existsSync(join(root, "EXECUTED"))).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );
  },
);
