import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const hook = resolve("src-tauri/scripts/dsh-npm-progress.cjs");
describe("private npm progress observer", () => {
  it("counts the whole unpack batch, ignores unrelated events and exports no package paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-progress-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--require",
          hook,
          "-e",
          `
        const fs = require('node:fs');
        process.emit('time', 'start', 'reifyNode:private-before-batch');
        process.emit('time', 'end', 'reifyNode:private-before-batch');
        process.emit('time', 'start', 'reify:unpack');
        for (const path of ['secret-A', 'secret-B', 'secret-C']) process.emit('time', 'start', 'reifyNode:' + path);
        process.emit('time', 'end', 'reifyNode:secret-A');
        process.emit('time', 'end', 'reifyNode:secret-A');
        process.emit('time', 'end', 'reifyNode:unknown');
        setImmediate(() => {
          console.log(fs.readFileSync('package-progress.json', 'utf8'));
          for (const path of ['secret-B', 'secret-C']) process.emit('time', 'end', 'reifyNode:' + path);
          process.emit('time', 'end', 'reify:unpack');
        });
      `,
        ],
        { cwd: dir, encoding: "utf8", timeout: 5000 },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ completed: 1, total: 3 });
      const content = readFileSync(join(dir, "package-progress.json"), "utf8");
      expect(JSON.parse(content)).toEqual({ completed: 3, total: 3 });
      expect(content).not.toMatch(/secret|private|unknown/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("preserves npm failure and does not fail installation when progress cannot be written", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-progress-failure-"));
    try {
      mkdirSync(join(dir, "package-progress.json.tmp"));
      const result = spawnSync(
        process.execPath,
        [
          "--require",
          hook,
          "-e",
          `
        process.emit('time', 'start', 'reify:unpack');
        process.emit('time', 'start', 'reifyNode:private-package');
        process.exitCode = 7;
      `,
        ],
        { cwd: dir, encoding: "utf8", timeout: 5000 },
      );
      expect(result.status).toBe(7);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
