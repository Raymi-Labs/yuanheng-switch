import { describe, expect, it } from "vitest";
import config from "../src-tauri/tauri.conf.json";
import ios from "../src-tauri/tauri.ios.conf.json";

describe("packaged audio policy", () => {
  const directives = Object.fromEntries(
    config.app.security.csp
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([key, ...values]) => [key, values]),
  );
  it("permits in-memory audio without expanding network media or scripts", () => {
    expect(directives["media-src"]).toEqual(["'self'", "data:", "blob:"]);
    expect(directives["script-src"]).toEqual(["'self'"]);
    expect(directives["connect-src"]).toEqual(["ipc:", "http://ipc.localhost"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
  });
  it("uses the same audio policy for iOS", () => {
    expect(ios).not.toHaveProperty("app.security.csp");
  });
});
