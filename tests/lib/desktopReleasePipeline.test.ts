import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  assembleRelease,
  collectTarget,
  publishRelease,
  prepareRecoveryContext,
  releaseContext,
  TARGETS,
  type ReleaseContext,
  type ReleasePlan,
} from "../../scripts/desktop-release.mjs";

const version = "0.1.53";
const context = releaseContext(
  {
    GITHUB_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_NUMBER: "8",
    GITHUB_REF: `refs/tags/v${version}`,
    GITHUB_REPOSITORY: "nanashiwang/yuanheng-switch",
  },
  version,
);
const feed = {
  schemaVersion: 1,
  releases: [version, "0.1.52"].map((version) => ({
    version,
    publishedAt: "2026-09-11T08:00:00Z",
    content: `元衡 v${version} 更新：完善供应商归属与周期统计，三平台并行构建。`,
  })),
};
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture(ctx: ReleaseContext = context) {
  const dir = mkdtempSync(join(tmpdir(), "yh-release-test-"));
  temps.push(dir);
  const inputDir = join(dir, "download");
  mkdirSync(inputDir);
  for (const target of TARGETS) {
    const bundle = join(
      dir,
      "src-tauri",
      "target",
      target,
      "release",
      "bundle",
    );
    const arch = target.startsWith("aarch64") ? "aarch64" : "x64";
    const files = target.endsWith("darwin")
      ? [
          "macos/YuanHeng Desktop.app.tar.gz",
          "macos/YuanHeng Desktop.app.tar.gz.sig",
          `dmg/YuanHeng Desktop_${version}_${arch}.dmg`,
        ]
      : [
          `nsis/YuanHeng Desktop_${version}_x64-setup.exe`,
          `nsis/YuanHeng Desktop_${version}_x64-setup.exe.sig`,
        ];
    const paths = files.map((file) => {
      const path = join(bundle, file);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(
        path,
        file.endsWith(".sig")
          ? Buffer.from(`signed-${target}`).toString("base64")
          : `binary:${target}:${file}`,
      );
      return path;
    });
    // tauri-action reports the .app directory alongside its already-signed archive.
    if (target.endsWith("darwin")) {
      const app = join(bundle, "macos/YuanHeng Desktop.app");
      mkdirSync(app);
      paths.push(app);
    }
    collectTarget({
      repoRoot: dir,
      outputDir: join(inputDir, `desktop-${target}`),
      target,
      artifactPaths: paths,
      appVersion: version,
      context: ctx,
      productName: "YuanHeng Desktop",
    });
  }
  const outputDir = join(dir, "final");
  return {
    dir,
    inputDir,
    outputDir,
    context: ctx,
    productName: "YuanHeng Desktop",
    feed,
  };
}

function fakeGithub(
  plan: ReleasePlan,
  outputDir: string,
  opts: {
    corrupt?: boolean;
    published?: boolean;
    newer?: boolean;
    uploadFailure?: boolean;
  } = {},
) {
  const notes = readFileSync(join(outputDir, "notes.txt"), "utf8");
  const assets = plan.assets.map((f) => ({
    name: f.name,
    size: f.size,
    state: "uploaded",
    digest: `sha256:${f.sha256}`,
  }));
  let release: any = opts.published
    ? {
        tag_name: plan.tag,
        target_commitish: plan.sha,
        draft: false,
        prerelease: false,
        body: notes,
        assets,
        html_url: "https://example.test/release",
      }
    : null;
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    if (args[0] === "release" && args[1] === "view") {
      if (!release) throw new Error("release not found");
      return JSON.stringify({ databaseId: 42 });
    }
    if (args[0] === "api") {
      if (args[1].includes("/releases/tags/") && release?.draft)
        throw new Error("gh: HTTP 404");
      if (args[1].includes("/git/ref/tags/")) {
        if (!plan.stable) throw new Error("gh: HTTP 404");
        return JSON.stringify({ object: { type: "tag", sha: "b".repeat(40) } });
      }
      if (args[1].includes("/git/tags/"))
        return JSON.stringify({ object: { type: "commit", sha: plan.sha } });
      if (args[1].endsWith("/latest"))
        return JSON.stringify({ tag_name: opts.newer ? "v9.0.0" : "v0.1.52" });
      if (!release) throw new Error("gh: HTTP 404");
      return JSON.stringify(release);
    }
    if (args[1] === "create")
      release = {
        tag_name: plan.tag,
        target_commitish: plan.sha,
        draft: true,
        prerelease: !plan.stable,
        body: notes,
        assets: [],
        html_url: "https://example.test/release",
      };
    if (args[1] === "upload") {
      if (opts.uploadFailure) throw new Error("upload interrupted");
      for (const path of args.filter((a) => a.startsWith(outputDir))) {
        const asset = assets.find((f) => f.name === basename(path))!;
        release.assets = release.assets.filter(
          (a: any) => a.name !== asset.name,
        );
        release.assets.push({
          ...asset,
          digest: opts.corrupt ? "sha256:bad" : asset.digest,
        });
      }
    }
    if (args[1] === "edit" && args.includes("--draft=false"))
      release.draft = false;
    return "";
  };
  return { gh, calls, current: () => release };
}

describe("parallel desktop release assembly", () => {
  it("keeps architecture-specific bytes, names, signatures and both announcements", () => {
    const f = fixture();
    const plan = assembleRelease(f);
    expect(plan.assets).toHaveLength(9);
    const manifest = JSON.parse(
      readFileSync(join(f.outputDir, "latest.json"), "utf8"),
    );
    expect(Object.keys(manifest.platforms)).toHaveLength(6);
    expect(manifest.release_notes.map((r: any) => r.version)).toEqual([
      version,
      "0.1.52",
    ]);
    expect(manifest.notes).toBe(feed.releases[0].content);
    expect(manifest.platforms["darwin-aarch64"].url).toBe(
      `https://github.com/nanashiwang/yuanheng-switch/releases/download/v${version}/YuanHeng.Desktop_${version}_aarch64.app.tar.gz`,
    );
    expect(manifest.platforms["windows-x86_64"].url).toContain(
      "_x64-setup.exe",
    );
    expect(manifest.platforms["darwin-x86_64"].signature).not.toBe(
      manifest.platforms["darwin-aarch64"].signature,
    );
    expect(
      readFileSync(
        join(f.outputDir, `YuanHeng.Desktop_${version}_x64.app.tar.gz`),
        "utf8",
      ),
    ).toContain("binary:x86_64-apple-darwin");
  });
  it("never creates a manifest when a platform is missing", () => {
    const f = fixture();
    rmSync(join(f.inputDir, `desktop-${TARGETS[1]}`), { recursive: true });
    expect(() => assembleRelease(f)).toThrow(/三平台/);
    expect(existsSync(f.outputDir)).toBe(false);
  });
  it.each(["sha", "runId", "version", "target"])(
    "rejects a receipt with a different %s",
    (key) => {
      const f = fixture();
      const path = join(f.inputDir, `desktop-${TARGETS[0]}`, "receipt.json");
      const receipt = JSON.parse(readFileSync(path, "utf8"));
      receipt[key] = "wrong";
      writeFileSync(path, JSON.stringify(receipt));
      expect(() => assembleRelease(f)).toThrow(/不一致/);
    },
  );
  it("rejects byte tampering and duplicate receipt entries", () => {
    const f = fixture();
    const path = join(
      f.inputDir,
      `desktop-${TARGETS[0]}`,
      `YuanHeng.Desktop_${version}_aarch64.app.tar.gz`,
    );
    const content = readFileSync(path);
    content[0] ^= 1;
    writeFileSync(path, content);
    expect(() => assembleRelease(f)).toThrow(/摘要/);
    const other = fixture();
    const receiptPath = join(
      other.inputDir,
      `desktop-${TARGETS[0]}`,
      "receipt.json",
    );
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    receipt.files.push(receipt.files[0]);
    writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(() => assembleRelease(other)).toThrow(/重复/);
  });
});

describe("single release publisher", () => {
  it("publishes a verified stable tag when default-branch workflows advanced", () => {
    const f = fixture();
    const plan = assembleRelease(f);
    const fake = fakeGithub(plan, f.outputDir);
    const gh = (args: string[]) => {
      if (
        args[0] === "release" &&
        args[1] === "create" &&
        args.includes("--target")
      ) {
        throw new Error("HTTP 403: Resource not accessible by integration");
      }
      return fake.gh(args);
    };
    expect(publishRelease({ ...f, gh }).draft).toBe(false);
    const create = fake.calls.find((c) => c[1] === "create")!;
    expect(create).toContain("--verify-tag");
    expect(create).not.toContain("--target");
    const tagCheck = fake.calls.findIndex((c) => c[1]?.includes("/git/tags/"));
    expect(tagCheck).toBeGreaterThanOrEqual(0);
    expect(tagCheck).toBeLessThan(fake.calls.indexOf(create));
  });

  it("uploads one manifest last and only publishes after GitHub digest verification", () => {
    const f = fixture();
    const plan = assembleRelease(f);
    const fake = fakeGithub(plan, f.outputDir);
    const result = publishRelease({ ...f, gh: fake.gh });
    expect(result.draft).toBe(false);
    expect(fake.calls.some((c) => c[0] === "release" && c[1] === "view")).toBe(
      true,
    );
    expect(
      fake.calls.some(
        (c) => c[0] === "api" && c[1].includes("/releases/tags/"),
      ),
    ).toBe(false);
    expect(fake.calls.find((c) => c[1] === "create")).toContain("--draft");
    const uploads = fake.calls.filter((c) => c[1] === "upload");
    expect(uploads).toHaveLength(2);
    expect(uploads[0].some((a) => a.endsWith("latest.json"))).toBe(false);
    expect(uploads[1].at(-1)).toBe(join(f.outputDir, "latest.json"));
    const publishIndex = fake.calls.findIndex((c) =>
      c.includes("--draft=false"),
    );
    expect(publishIndex).toBeGreaterThan(fake.calls.indexOf(uploads[1]) + 1);
  });
  it.each([{ corrupt: true }, { uploadFailure: true }])(
    "leaves failures as drafts: %j",
    (opts) => {
      const f = fixture();
      const plan = assembleRelease(f);
      const fake = fakeGithub(plan, f.outputDir, opts);
      expect(() => publishRelease({ ...f, gh: fake.gh })).toThrow();
      expect(fake.current().draft).toBe(true);
      expect(fake.calls.some((c) => c.includes("--draft=false"))).toBe(false);
    },
  );
  it("does not mutate a successfully published identical release on retry", () => {
    const f = fixture();
    const plan = assembleRelease(f);
    const fake = fakeGithub(plan, f.outputDir, { published: true });
    // GitHub may retain a branch name in target_commitish for an existing tag.
    fake.current().target_commitish = "main";
    publishRelease({ ...f, gh: fake.gh });
    expect(
      fake.calls.every(
        (c) => c[0] === "api" || (c[0] === "release" && c[1] === "view"),
      ),
    ).toBe(true);
  });
  it("keeps manual runs as complete prerelease drafts", () => {
    const ctx = releaseContext(
      {
        GITHUB_SHA: context.sha,
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_NUMBER: "8",
        GITHUB_REF: "refs/heads/main",
        GITHUB_REPOSITORY: context.repo,
      },
      version,
    );
    const f = fixture(ctx);
    const plan = assembleRelease(f);
    const fake = fakeGithub(plan, f.outputDir);
    const result = publishRelease({ ...f, gh: fake.gh });
    expect(ctx.tag).toBe("v0.1.53-build.8");
    const create = fake.calls.find((c) => c[1] === "create")!;
    expect(create[create.indexOf("--target") + 1]).toBe(ctx.sha);
    expect(create).not.toContain("--verify-tag");
    expect(result.draft && result.prerelease).toBe(true);
    expect(fake.current().assets).toHaveLength(9);
    expect(fake.calls.some((c) => c.includes("--draft=false"))).toBe(false);
  });
  it("refuses a tag that points to a different commit before any write", () => {
    const f = fixture();
    const plan = assembleRelease(f);
    const fake = fakeGithub(plan, f.outputDir);
    const gh = (args: string[]) =>
      args[1]?.includes("/git/tags/")
        ? JSON.stringify({ object: { type: "commit", sha: "c".repeat(40) } })
        : fake.gh(args);
    expect(() => publishRelease({ ...f, gh })).toThrow(/标签与构建提交/);
    expect(fake.calls.every((c) => c[0] === "api")).toBe(true);
  });

  it("does not replace a newer GitHub latest release", () => {
    const f = fixture();
    const plan = assembleRelease(f);
    const fake = fakeGithub(plan, f.outputDir, { newer: true });
    publishRelease({ ...f, gh: fake.gh });
    expect(fake.calls.find((c) => c.includes("--draft=false"))).toContain(
      "--latest=false",
    );
  });
});

describe("release recovery provenance", () => {
  function sourceFixture() {
    const run = {
      id: 123,
      repository: { full_name: context.repo },
      path: ".github/workflows/release.yml",
      event: "push",
      status: "completed",
      head_sha: context.sha,
      head_branch: context.tag,
    };
    const jobs = ["validate", ...TARGETS.map((t) => `Build ${t}`)].map(
      (name, id) => ({
        name,
        id,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
      }),
    );
    const gh = (args: string[]) => {
      const path = args[1];
      if (path.includes("/jobs?")) return JSON.stringify({ jobs });
      if (path.endsWith("/actions/runs/123")) return JSON.stringify(run);
      if (path.includes("/git/ref/tags/"))
        return JSON.stringify({ object: { type: "commit", sha: context.sha } });
      if (path.includes("/contents/")) {
        expect(path).toContain(`?ref=${context.sha}`);
        const data = path.includes("tauri.conf.json")
          ? { version, productName: "YuanHeng Desktop" }
          : feed;
        return JSON.stringify({
          encoding: "base64",
          content: Buffer.from(JSON.stringify(data)).toString("base64"),
        });
      }
      throw new Error(`Unexpected API ${path}`);
    };
    return { run, jobs, gh };
  }
  it("reuses the original successful build commit, run and announcement metadata", () => {
    const f = sourceFixture();
    const recovered = prepareRecoveryContext({
      runId: "123",
      repo: context.repo,
      gh: f.gh,
    });
    expect(recovered.context).toEqual(context);
    expect(recovered.config.version).toBe(version);
    expect(recovered.feed).toEqual(feed);
  });
  it("cannot bypass an active source run or a failed build retry", () => {
    const f = sourceFixture();
    f.run.status = "in_progress";
    expect(() =>
      prepareRecoveryContext({ runId: "123", repo: context.repo, gh: f.gh }),
    ).toThrow(/已结束/);
    f.run.status = "completed";
    f.jobs.push({
      ...f.jobs[1],
      id: 99,
      run_attempt: 2,
      conclusion: "failure",
    });
    expect(() =>
      prepareRecoveryContext({ runId: "123", repo: context.repo, gh: f.gh }),
    ).toThrow(/未全部通过/);
  });
  it("rejects unrelated repositories or workflows", () => {
    const f = sourceFixture();
    f.run.repository.full_name = "other/repo";
    expect(() =>
      prepareRecoveryContext({ runId: "123", repo: context.repo, gh: f.gh }),
    ).toThrow(/本仓库/);
    f.run.repository.full_name = context.repo;
    f.run.path = ".github/workflows/unrelated.yml";
    expect(() =>
      prepareRecoveryContext({ runId: "123", repo: context.repo, gh: f.gh }),
    ).toThrow(/正式发布/);
  });
});
