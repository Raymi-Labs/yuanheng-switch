import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DESKTOP_COMPONENTS = ["FocusToolCard.tsx", "ToolSetupGrid.tsx"].map(
  (file) =>
    path.resolve(__dirname, "..", "..", "src", "components", "desktop", file),
);

describe("desktop select coverage", () => {
  it("does not use native selects in model and group controls", () => {
    for (const file of DESKTOP_COMPONENTS) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, path.basename(file)).not.toContain("<select");
    }
  });
});
