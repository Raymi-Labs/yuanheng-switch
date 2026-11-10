import type { MediaDraft, MediaModel } from "@/lib/api/media-studio";

// Only non-sensitive knobs. Never serialize a full draft, prompt or reference.
export type MediaParameters = Pick<
  MediaDraft,
  | "size"
  | "duration"
  | "quality"
  | "resolution"
  | "outputFormat"
  | "background"
  | "outputCompression"
>;
export function mediaPreferenceKey(scope: string, kind: string, group: string) {
  return `media-preferences-v2:${JSON.stringify([scope, kind, group])}`;
}
export function loadMediaPreference(
  key: string,
): { model: string; parameters: MediaParameters } | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      !value ||
      typeof value.model !== "string" ||
      typeof value.parameters?.size !== "string"
    )
      return null;
    return { model: value.model, parameters: safeParameters(value.parameters) };
  } catch {
    return null;
  }
}
export function safeParameters(p: MediaParameters): MediaParameters {
  return {
    size: p.size,
    duration: p.duration,
    quality: p.quality,
    resolution: p.resolution,
    outputFormat: p.outputFormat,
    background: p.background,
    outputCompression: p.outputCompression,
  };
}
export function saveMediaPreference(
  key: string,
  model: string,
  parameters: MediaParameters,
) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ model, parameters: safeParameters(parameters) }),
    );
  } catch {
    /* optional preference */
  }
}
export function defaultMediaParameters(model: MediaModel): MediaParameters {
  return {
    size: model.sizes[0] ?? "",
    duration: model.durations[0] ?? null,
    quality: model.qualities?.[0],
    resolution: model.resolutions?.[0],
    outputFormat: model.outputFormats?.[0],
    background: model.backgrounds?.[0],
  };
}
export function mediaSizeValid(model: MediaModel, size: string) {
  if (model.sizes.includes(size)) return true;
  if (!model.customSize || !/^\d+x\d+$/.test(size)) return false;
  const [w, h] = size.split("x").map(Number);
  return (
    w > 0 &&
    h > 0 &&
    w <= 3840 &&
    h <= 3840 &&
    w % 16 === 0 &&
    h % 16 === 0 &&
    w <= h * 3 &&
    h <= w * 3 &&
    w * h >= 655360 &&
    w * h <= 8294400
  );
}
export function mediaParametersValid(m: MediaModel, p: MediaParameters) {
  return (
    mediaSizeValid(m, p.size) &&
    (m.kind === "image"
      ? p.duration == null
      : m.durations.includes(p.duration ?? 0)) &&
    [
      [p.quality, m.qualities],
      [p.resolution, m.resolutions],
      [p.outputFormat, m.outputFormats],
      [p.background, m.backgrounds],
    ].every(
      ([v, allowed]) =>
        v == null || (Array.isArray(allowed) && allowed.includes(v as string)),
    ) &&
    !(p.background === "transparent" && p.outputFormat === "jpeg") &&
    (p.outputCompression == null ||
      (["jpeg", "webp"].includes(p.outputFormat ?? "") &&
        Number.isInteger(p.outputCompression) &&
        p.outputCompression >= 0 &&
        p.outputCompression <= 100))
  );
}
