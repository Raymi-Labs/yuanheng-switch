// GPT Image edit API: https://developers.openai.com/api/reference/resources/images/methods/edit
export function mediaReferencePolicy(model: string) {
  const gpt = model.startsWith("gpt-image-");
  const video =
    model.split(/[-_]/).some((part) => ["video", "seedance"].includes(part)) ||
    ["sora-", "kling-", "vidu", "MiniMax-Hailuo-", "MiniMax-H3", "wan2."].some(
      (p) => model.startsWith(p),
    );
  return {
    maxCount: gpt ? 16 : video ? 16 : 1,
    maxBytes: (gpt ? 50 : 10) * 1024 * 1024,
    exclusiveBytes: gpt,
    maxTotalBytes: video ? 64 * 1024 * 1024 : Infinity,
    mimeTypes:
      gpt || video
        ? ["image/png", "image/jpeg", "image/webp"]
        : ["image/png", "image/jpeg"],
  };
}

export function referenceBytes(raw: string) {
  const data = raw.split(",")[1] ?? "";
  return (
    (data.length * 3) / 4 -
    (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
  );
}

export function referencesFit(model: string, references: string[]) {
  const policy = mediaReferencePolicy(model);
  return (
    references.length <= policy.maxCount &&
    references.every((raw) => {
      const mime = raw.slice(5, raw.indexOf(";"));
      const bytes = referenceBytes(raw);
      return (
        policy.mimeTypes.includes(mime) &&
        (policy.exclusiveBytes
          ? bytes < policy.maxBytes
          : bytes <= policy.maxBytes)
      );
    }) &&
    references.reduce((sum, raw) => sum + referenceBytes(raw), 0) <=
      policy.maxTotalBytes
  );
}
