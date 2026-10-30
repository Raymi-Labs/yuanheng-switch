import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { settingsApi } from "@/lib/api";
import { toolDetectionEpoch } from "@/lib/toolDetectionEpoch";
import {
  readToolInventoryCache,
  TOOL_INVENTORY_CACHE_TTL_MS,
  writeToolInventoryCache,
} from "@/components/desktop/toolInventoryCache";

export const DESKTOP_INVENTORY_TARGETS = [
  "claude",
  "claude-desktop",
  "codex",
  "chatgpt-desktop",
  "workbuddy",
  "trae",
  "trae-cn",
  "dsh",
  "accio-work",
  "gemini",
  "grok",
  "opencode",
  "openclaw",
  "hermes",
];
export const DESKTOP_INVENTORY_KEY = ["desktop", "tool-inventory"] as const;

/** Account-neutral local inventory only. Never restore credentials or readiness. */
export function useToolInventory() {
  const snapshot = useMemo(
    () => readToolInventoryCache(DESKTOP_INVENTORY_TARGETS),
    [],
  );
  return useQuery({
    queryKey: DESKTOP_INVENTORY_KEY,
    queryFn: async () => {
      const startedAt = performance.now();
      const epoch = toolDetectionEpoch();
      const data = await settingsApi.getInstalledToolVersions(
        DESKTOP_INVENTORY_TARGETS,
      );
      if (epoch !== toolDetectionEpoch())
        throw new Error("工具设置已变化，请重新检测");
      writeToolInventoryCache(
        DESKTOP_INVENTORY_TARGETS,
        data,
        performance.now() - startedAt,
      );
      return data;
    },
    initialData: snapshot?.data,
    initialDataUpdatedAt: snapshot?.savedAt,
    staleTime: TOOL_INVENTORY_CACHE_TTL_MS,
    retry: false,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
  });
}
