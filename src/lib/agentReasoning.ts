import type { YuanhengReasoningLevel, YuanhengToolId } from "./api/yuanheng";
import definitions from "@/data/agent-reasoning-controls.json";
const rules: Record<
  string,
  { levels: string[] | null; modelPrefixes?: string[] }
> = definitions;
/** Shared with Rust. Native accepted values intersect the model catalog. */
export function toolReasoningLevels(
  app: YuanhengToolId,
  model: string | undefined,
  levels: YuanhengReasoningLevel[] = [],
): YuanhengReasoningLevel[] {
  const rule = rules[app];
  if (
    !rule ||
    (rule.modelPrefixes &&
      !rule.modelPrefixes.some((prefix) => model?.startsWith(prefix)))
  )
    return [];
  return levels.filter(
    (level) =>
      level !== "auto" && (!rule.levels || rule.levels.includes(level)),
  );
}
