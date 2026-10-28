import type { ToolVersionInfo } from "@/lib/api/settings";
import { invalidateToolDetection } from "@/lib/toolDetectionEpoch";

const CACHE_KEY = "yuanheng.desktop.tool-inventory.v2";
export const TOOL_INVENTORY_CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

interface ToolInventoryCacheRecord {
  savedAt: number;
  targets: string[];
  data: ToolVersionInfo[];
  detectionMs?: number;
}

const normalizeTargets = (targets: string[]) =>
  [...new Set(targets)].sort((left, right) => left.localeCompare(right));

export function readToolInventoryCache(
  targets: string[],
): ToolInventoryCacheRecord | undefined {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw || raw.length > 128_000) return undefined;
    const parsed = JSON.parse(raw) as ToolInventoryCacheRecord;
    if (
      !Number.isFinite(parsed.savedAt) ||
      parsed.savedAt > Date.now() ||
      Date.now() - parsed.savedAt > CACHE_MAX_AGE_MS ||
      !Array.isArray(parsed.targets) ||
      !Array.isArray(parsed.data) ||
      parsed.targets.length > 32 ||
      parsed.data.length > 32 ||
      !parsed.targets.every((target: unknown) => typeof target === "string") ||
      !parsed.data.every(
        (item: unknown) =>
          item !== null &&
          typeof item === "object" &&
          typeof (item as ToolVersionInfo).name === "string" &&
          targets.includes((item as ToolVersionInfo).name) &&
          typeof (item as ToolVersionInfo).installed_but_broken === "boolean" &&
          ["windows", "wsl", "macos", "linux", "unknown"].includes(
            (item as ToolVersionInfo).env_type,
          ) &&
          ((item as ToolVersionInfo).version == null ||
            typeof (item as ToolVersionInfo).version === "string"),
      )
    ) {
      return undefined;
    }
    if (
      new Set(parsed.data.map((item) => item.name)).size !== parsed.data.length
    )
      return undefined;
    const requested = normalizeTargets(targets);
    const cached = normalizeTargets(parsed.targets);
    if (
      requested.length !== cached.length ||
      requested.some((target, index) => target !== cached[index])
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeToolInventoryCache(
  targets: string[],
  data: ToolVersionInfo[],
  detectionMs?: number,
) {
  try {
    const record: ToolInventoryCacheRecord = {
      savedAt: Date.now(),
      targets: normalizeTargets(targets),
      data: data.map((item) => ({
        name: item.name,
        version: item.version,
        latest_version: null,
        // Keep structural location fields, not arbitrary stderr or future credentials.
        error: item.error ? "上次检测未完成，请重新检测" : null,
        installed_but_broken: item.installed_but_broken,
        env_type: item.env_type,
        wsl_distro: item.wsl_distro,
        install_path: item.install_path,
        detection_source: item.detection_source,
        custom_path: item.custom_path,
        custom_path_valid: item.custom_path_valid,
      })),
      detectionMs: Number.isFinite(detectionMs)
        ? Math.round(detectionMs!)
        : undefined,
    };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(record));
  } catch {
    // Cache failures must never block live detection.
  }
}

export function clearToolInventoryCache() {
  invalidateToolDetection();
  try {
    window.localStorage.removeItem(CACHE_KEY);
  } catch {
    // Ignore unavailable storage (private mode / hardened WebView).
  }
}
