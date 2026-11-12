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
  if (model.kind === "video") {
    const parts = size.split(/[x:]/);
    return (
      /^[1-9]\d*(?:x|:)[1-9]\d*$/.test(size) &&
      parts.every(
        (v) => Number.isSafeInteger(Number(v)) && Number(v) <= 0xffffffff,
      )
    );
  }
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
export function updateVideoDimensions(
  p: MediaParameters,
  patch: Partial<MediaParameters>,
): MediaParameters {
  const next = { ...p, ...patch };
  if (patch.size !== undefined && /^[1-9]\d*x[1-9]\d*$/.test(patch.size)) {
    const [w, h] = patch.size.split("x").map(Number);
    next.resolution = `${Math.min(w, h)}p`;
  } else if (patch.resolution !== undefined && p.size.includes("x")) {
    const [w, h] = p.size.split("x").map(Number);
    const pixels = /^([1-9]\d*)p$/.exec(patch.resolution);
    const scale = pixels ? Number(pixels[1]) / Math.min(w, h) : NaN;
    if (
      Number.isSafeInteger(w * scale) &&
      Number.isSafeInteger(h * scale) &&
      Math.max(w * scale, h * scale) <= 0xffffffff
    ) {
      next.size = `${w * scale}x${h * scale}`;
    } else {
      next.size = `${w}:${h}`; // retain ratio; unknown resolution is not a pixel size
    }
  }
  return next;
}
export function videoDimensionsConsistent(p: MediaParameters) {
  if (
    !p.size.includes("x") ||
    !p.resolution ||
    !/^[1-9]\d*p$/.test(p.resolution)
  )
    return true;
  return (
    Math.min(...p.size.split("x").map(Number)) ===
    Number(p.resolution.slice(0, -1))
  );
}
export function mediaParametersValid(m: MediaModel, p: MediaParameters) {
  return (
    mediaSizeValid(m, p.size) &&
    (m.kind !== "video" || videoDimensionsConsistent(p)) &&
    (m.kind === "image"
      ? p.duration == null
      : Number.isInteger(p.duration) &&
        (p.duration ?? 0) > 0 &&
        (p.duration ?? 0) <= 0xffffffff) &&
    [
      [p.quality, m.qualities],
      [p.resolution, m.resolutions],
      [p.outputFormat, m.outputFormats],
      [p.background, m.backgrounds],
    ].every(
      ([v, allowed], index) =>
        v == null ||
        (Array.isArray(allowed) && allowed.includes(v as string)) ||
        (m.kind === "video" &&
          index === 1 &&
          typeof v === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(v)),
    ) &&
    !(p.background === "transparent" && p.outputFormat === "jpeg") &&
    (p.outputCompression == null ||
      (["jpeg", "webp"].includes(p.outputFormat ?? "") &&
        Number.isInteger(p.outputCompression) &&
        p.outputCompression >= 0 &&
        p.outputCompression <= 100))
  );
}
