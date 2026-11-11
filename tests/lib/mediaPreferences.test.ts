import { describe, it, expect, beforeEach } from "vitest";
import {
  loadMediaPreference,
  saveMediaPreference,
  mediaPreferenceKey,
  mediaParametersValid,
  defaultMediaParameters,
} from "@/lib/mediaPreferences";
import type { MediaModel } from "@/lib/api/media-studio";
const model: MediaModel = {
  id: "gpt-image-2.5-sunburst",
  kind: "image",
  reference: "optional",
  sizes: ["1024x1024", "3840x2160"],
  durations: [],
  qualities: ["auto", "max"],
  outputFormats: ["png", "jpeg", "webp"],
  backgrounds: ["auto", "transparent"],
  customSize: true,
};
beforeEach(() => localStorage.clear());
describe("media preference privacy and parameter invariants", () => {
  it("isolates account/type/group and writes only approved knobs", () => {
    const key = mediaPreferenceKey("account-a", "image", "one");
    const draft = {
      ...defaultMediaParameters(model),
      prompt: "private",
      reference: "private-image",
      token: "secret",
    };
    saveMediaPreference(key, model.id, draft);
    const raw = localStorage.getItem(key)!;
    expect(raw).not.toMatch(/private|secret|prompt|reference|token/);
    expect(loadMediaPreference(key)?.model).toBe(model.id);
    expect(
      loadMediaPreference(mediaPreferenceKey("account-b", "image", "one")),
    ).toBeNull();
    expect(
      loadMediaPreference(mediaPreferenceKey("account-a", "video", "one")),
    ).toBeNull();
    expect(
      loadMediaPreference(mediaPreferenceKey("account-a", "image", "two")),
    ).toBeNull();
  });
  it("validates custom dimensions and transparency without accepting unsupported options", () => {
    const p = defaultMediaParameters(model);
    expect(
      mediaParametersValid(model, { ...p, size: "3840x2160", quality: "max" }),
    ).toBe(true);
    expect(mediaParametersValid(model, { ...p, size: "1536x864" })).toBe(true);
    for (const size of [
      "3841x2160",
      "999999999999x999999999999",
      "16x16",
      "1x1000",
      "0x0",
    ]) {
      expect(mediaParametersValid(model, { ...p, size })).toBe(false);
    }
    expect(
      mediaParametersValid(model, {
        ...p,
        outputFormat: "jpeg",
        background: "transparent",
      }),
    ).toBe(false);
    expect(mediaParametersValid(model, { ...p, outputCompression: 90 })).toBe(
      false,
    );
    expect(
      mediaParametersValid(model, {
        ...p,
        outputFormat: "webp",
        outputCompression: 90,
      }),
    ).toBe(true);
    expect(mediaParametersValid(model, { ...p, resolution: "4K" })).toBe(false);
  });
  it("tolerates missing or corrupt preferences", () => {
    localStorage.setItem("bad", "{");
    expect(loadMediaPreference("bad")).toBeNull();
    localStorage.setItem("bad", JSON.stringify({ model: 1, parameters: {} }));
    expect(loadMediaPreference("bad")).toBeNull();
  });
});

describe("server-authorized video parameters", () => {
  it("keeps explicit resolution, ratio and duration beyond preset suggestions", () => {
    const video: MediaModel = {
      id: "doubao-seedance-2-5-260628",
      kind: "video",
      reference: "optional",
      sizes: ["16:9"],
      durations: [4],
      resolutions: ["720p", "1080p"],
      customSize: true,
    };
    expect(
      mediaParametersValid(video, {
        size: "21:9",
        duration: 30,
        resolution: "2160p",
      }),
    ).toBe(true);
    expect(
      mediaParametersValid(video, {
        size: "1920x1080",
        duration: 8,
        resolution: "1080p",
      }),
    ).toBe(true);
    expect(
      mediaParametersValid(video, {
        size: "16:9",
        duration: 0,
        resolution: "720p",
      }),
    ).toBe(false);
  });
});
