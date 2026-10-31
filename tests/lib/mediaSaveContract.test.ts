import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { mediaStudioApi } from "@/lib/api/media-studio";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
describe("media native save contract", () => {
  it.each(["mp4", "png", "jpg", "webp"] as const)(
    "uses the dedicated native command for %s",
    async (extension) => {
      invoke.mockResolvedValue(null);
      expect(
        await mediaStudioApi.saveDialog(`作品.${extension}`, extension),
      ).toBeNull();
      expect(invoke).toHaveBeenLastCalledWith("save_media_file_dialog", {
        defaultName: `作品.${extension}`,
        extension,
      });
    },
  );
  it("connects native media filters to the dialog without changing database SQL export", () => {
    const media = readFileSync(
      "src-tauri/src/commands/yuanheng/media_studio.rs",
      "utf8",
    );
    const database = readFileSync(
      "src-tauri/src/commands/import_export.rs",
      "utf8",
    );
    const registry = readFileSync("src-tauri/src/lib.rs", "utf8");
    const page = readFileSync(
      "src/components/desktop/MediaStudioPage.tsx",
      "utf8",
    );
    expect(media).toContain("media_save_filter(extension)?");
    expect(media).toMatch(/\.add_filter\(label, extensions\)/);
    expect(media).toContain(
      "media_save_builder(&app, &default_name, &extension)?",
    );
    expect(registry).toContain("commands::save_media_file_dialog");
    expect(page).toContain("mediaStudioApi.saveDialog(");
    expect(page).not.toContain("settingsApi.saveFileDialog(");
    expect(database).toContain('.add_filter("SQL", &["sql"])');
  });
});
