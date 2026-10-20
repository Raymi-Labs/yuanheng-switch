import { platformPricingKey, usePlatformPricing } from "./platformPricing";
import { YUANHENG_WEBSITE_URL } from "@/config/yuanhengBrand";
import { usageKeys } from "./usage";
import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isCredentialAccessRequired } from "@/lib/api/yuanheng";
import { yuanhengApi } from "@/lib/api";
import type {
  CodexAccountMode,
  YuanhengReasoningLevel,
  YuanhengToolId,
} from "@/lib/api";

export const yuanhengKeys = {
  connection: ["yuanheng", "connection"] as const,
  announcements: ["yuanheng", "announcements"] as const,
  tools: ["yuanheng", "tools"] as const,
  diagnostics: ["yuanheng", "diagnostics"] as const,
  codexBridge: ["yuanheng", "codex-bridge"] as const,
  codexAccountMode: ["yuanheng", "codex-account-mode"] as const,
  activation: ["yuanheng", "activation"] as const,
};

export function useYuanhengConnection() {
  usePlatformPricing();
  const query = useQuery({
    queryKey: yuanhengKeys.connection,
    queryFn: () => yuanhengApi.getConnection(),
    retry: false,
    // The access screen mounts another observer after a startup error. Retrying
    // on that mount would toggle the loading screen and remount forever.
    retryOnMount: false,
    staleTime: 30_000,
  });
  // A previous account snapshot must not mask inaccessible credentials.
  return {
    ...query,
    data: isCredentialAccessRequired(query.error) ? undefined : query.data,
  };
}

export function useRestoreYuanhengKeychainAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => yuanhengApi.restoreKeychainAccess(),
    retry: false,
    onSuccess: (status) => {
      queryClient.invalidateQueries({ queryKey: platformPricingKey });
      queryClient.setQueryData(yuanhengKeys.connection, status);
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.tools });
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.diagnostics });
      queryClient.invalidateQueries({ queryKey: usageKeys.all });
    },
  });
}

export function useYuanhengAnnouncements(enabled = true) {
  return useQuery({
    queryKey: yuanhengKeys.announcements,
    queryFn: () => yuanhengApi.getAnnouncements(),
    enabled,
    retry: 2,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: "always",
  });
}

export function useLoginYuanheng() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      username,
      password,
    }: {
      username: string;
      password: string;
    }) => yuanhengApi.login(username, password),
    onSuccess: (result) => {
      if (result.connection) {
        queryClient.invalidateQueries({ queryKey: platformPricingKey });
        queryClient.invalidateQueries({ queryKey: usageKeys.all });
        queryClient.setQueryData(yuanhengKeys.connection, result.connection);
        queryClient.invalidateQueries({ queryKey: yuanhengKeys.tools });
        queryClient.invalidateQueries({ queryKey: yuanhengKeys.diagnostics });
      }
    },
  });
}

export function useRegisterYuanheng() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      username,
      password,
    }: {
      username: string;
      password: string;
    }) => yuanhengApi.register(username, password),
    onSuccess: (result) => {
      if (result.connection) {
        queryClient.invalidateQueries({ queryKey: platformPricingKey });
        queryClient.invalidateQueries({ queryKey: usageKeys.all });
        queryClient.setQueryData(yuanhengKeys.connection, result.connection);
        queryClient.invalidateQueries({ queryKey: yuanhengKeys.tools });
        queryClient.invalidateQueries({ queryKey: yuanhengKeys.diagnostics });
      }
    },
  });
}

export function useVerifyYuanhengTwoFactor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => yuanhengApi.verifyTwoFactor(code),
    onSuccess: (result) => {
      if (result.connection) {
        queryClient.invalidateQueries({ queryKey: platformPricingKey });
        queryClient.invalidateQueries({ queryKey: usageKeys.all });
        queryClient.setQueryData(yuanhengKeys.connection, result.connection);
        queryClient.invalidateQueries({ queryKey: yuanhengKeys.tools });
        queryClient.invalidateQueries({ queryKey: yuanhengKeys.diagnostics });
      }
    },
  });
}

export function useRefreshYuanheng() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => yuanhengApi.refresh(),
    onSuccess: (status) => {
      queryClient.invalidateQueries({ queryKey: platformPricingKey });
      queryClient.invalidateQueries({ queryKey: usageKeys.all });
      queryClient.setQueryData(yuanhengKeys.connection, status);
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.tools });
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.diagnostics });
      queryClient.invalidateQueries({
        queryKey: yuanhengKeys.codexAccountMode,
      });
    },
    onError: () => {
      // 后端会在会话过期时清理本机会话，重新读取连接状态以退出过期缓存。
      void queryClient.invalidateQueries({ queryKey: yuanhengKeys.connection });
    },
  });
}

export function useSignOutYuanheng() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => yuanhengApi.signOut(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformPricingKey });
      queryClient.invalidateQueries({ queryKey: usageKeys.all });
      queryClient.setQueryData(yuanhengKeys.connection, {
        connected: false,
        baseUrl: YUANHENG_WEBSITE_URL,
        userId: null,
        account: null,
        models: [],
        terminalModels: [],
        imageGenerationModels: [],
        groups: [],
        modelGroups: {},
        modelVendors: {},
        reasoningLevels: {},
        reasoningDefaults: {},
        announcement: null,
        lastSyncedAt: null,
      });
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.tools });
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.diagnostics });
      queryClient.invalidateQueries({
        queryKey: yuanhengKeys.codexAccountMode,
      });
    },
  });
}

export function useYuanhengToolStatuses() {
  const { data: connection } = useYuanhengConnection();
  return useQuery({
    // A sync changes content, not identity. New timestamp keys would unmount
    // open model pickers while the replacement query has no data.
    queryKey: [
      ...yuanhengKeys.tools,
      connection?.baseUrl ?? null,
      connection?.userId ?? null,
      Boolean(connection?.connected),
    ],
    queryFn: () => yuanhengApi.getToolStatuses(),
    enabled: Boolean(connection?.connected),
    retry: false,
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useYuanhengToolActivationStatuses() {
  const queryClient = useQueryClient();
  const { data: connection } = useYuanhengConnection();
  const query = useQuery({
    queryKey: [
      ...yuanhengKeys.activation,
      connection?.userId ?? null,
      connection?.lastSyncedAt ?? null,
    ],
    queryFn: () => yuanhengApi.getToolActivationStatuses(),
    enabled: Boolean(connection?.connected),
    retry: false,
    staleTime: 5_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void listen("usage-log-recorded", () => {
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.activation });
    })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {
        /* 无事件桥时仍有低频轮询兜底。 */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [queryClient]);
  return query;
}

export function usePreflightYuanhengTool() {
  return useMutation({
    mutationFn: ({
      app,
      model,
      group,
      reasoning,
    }: {
      app: YuanhengToolId;
      model: string;
      group?: string;
      reasoning?: YuanhengReasoningLevel;
    }) => yuanhengApi.preflightTool(app, model, group, reasoning),
  });
}

export function useCodexSessionBridgeStatus() {
  return useQuery({
    queryKey: yuanhengKeys.codexBridge,
    queryFn: () => yuanhengApi.getCodexSessionBridgeStatus(),
    retry: false,
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  });
}

export function useCodexAccountMode() {
  return useQuery({
    queryKey: yuanhengKeys.codexAccountMode,
    queryFn: () => yuanhengApi.getCodexAccountMode(),
    retry: false,
    refetchOnWindowFocus: true,
  });
}

export function useSwitchCodexAccountMode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      mode,
      expectedMode,
    }: {
      mode: Exclude<CodexAccountMode, "unknown">;
      expectedMode?: CodexAccountMode;
    }) => yuanhengApi.switchCodexAccountMode(mode, expectedMode),
    onSuccess: (status) => {
      queryClient.setQueryData(yuanhengKeys.codexAccountMode, status);
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.tools });
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.diagnostics });
      queryClient.invalidateQueries({
        queryKey: yuanhengKeys.codexAccountMode,
      });
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.codexBridge });
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.activation });
      queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
      queryClient.invalidateQueries({
        queryKey: ["desktop", "tool-connections"],
      });
    },
  });
}

export function useYuanhengDiagnostics(enabled = true) {
  const { data: connection } = useYuanhengConnection();
  return useQuery({
    queryKey: [
      ...yuanhengKeys.diagnostics,
      connection?.userId ?? null,
      connection?.connected ?? false,
      connection?.lastSyncedAt ?? null,
    ],
    queryFn: () => yuanhengApi.getDiagnostics(),
    enabled,
    retry: false,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useRepairYuanheng() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (actions: string[] = []) => {
      // 同步优先；不要在工具尚未重配前撤销仍可能被使用的旧令牌。
      const connection = await yuanhengApi.refresh();
      const statuses = await yuanhengApi.getToolStatuses();
      const codexMode = await yuanhengApi.getCodexAccountMode();
      const apps = statuses
        .filter(
          (item) =>
            !(
              codexMode.mode === "official" &&
              (item.app === "codex" || item.app === "chatgpt-desktop")
            ),
        )
        .filter(
          (item) =>
            item.needsUpdate ||
            ((actions.includes("repair_tools") ||
              actions.includes("repair_credentials")) &&
              item.configured),
        )
        .map((item) => item.app);
      if (apps.length > 0) {
        const results = await yuanhengApi.configureTools(apps);
        const failed = results.filter((item) => !item.configured);
        if (failed.length)
          throw new Error(
            failed.map((item) => item.error || item.app).join("；"),
          );
      }
      return { connection, repairedTools: apps };
    },
    onSuccess: ({ connection }) => {
      queryClient.invalidateQueries({ queryKey: platformPricingKey });
      queryClient.invalidateQueries({ queryKey: usageKeys.all });
      queryClient.setQueryData(yuanhengKeys.connection, connection);
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.tools });
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.diagnostics });
    },
  });
}

export function useRotateYuanhengCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const connection = await yuanhengApi.rotateDeviceToken();
      const statuses = await yuanhengApi.getToolStatuses();
      const codexMode = await yuanhengApi.getCodexAccountMode();
      const apps = statuses
        .filter(
          (item) =>
            !(
              codexMode.mode === "official" &&
              (item.app === "codex" || item.app === "chatgpt-desktop")
            ),
        )
        .filter((item) => item.needsUpdate || item.configured)
        .map((item) => item.app);
      if (apps.length > 0) {
        const results = await yuanhengApi.configureTools(apps);
        const failed = results.filter((item) => !item.configured);
        if (failed.length)
          throw new Error(
            failed.map((item) => item.error || item.app).join("；"),
          );
      }
      return { connection, updatedTools: apps };
    },
    onSuccess: ({ connection }) => {
      queryClient.invalidateQueries({ queryKey: platformPricingKey });
      queryClient.invalidateQueries({ queryKey: usageKeys.all });
      queryClient.setQueryData(yuanhengKeys.connection, connection);
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.tools });
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.diagnostics });
    },
  });
}

export function useRollbackYuanhengTools() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => yuanhengApi.rollbackTools(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.tools });
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.diagnostics });
      queryClient.invalidateQueries({
        queryKey: yuanhengKeys.codexAccountMode,
      });
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.activation });
      queryClient.invalidateQueries({
        queryKey: ["desktop", "tool-connections"],
      });
    },
  });
}

export function useConfigureYuanhengTools() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      apps,
      models,
      groups,
      reasoning,
    }: {
      apps: YuanhengToolId[];
      models?: Partial<Record<YuanhengToolId, string>>;
      groups?: Partial<Record<YuanhengToolId, string>>;
      reasoning?: Partial<Record<YuanhengToolId, YuanhengReasoningLevel>>;
    }) => yuanhengApi.configureTools(apps, models, groups, reasoning),
    // System preparation may be deferred after configuration has been saved.
    // Refresh saved choices on either outcome so resuming cannot show stale data.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.tools });
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.diagnostics });
      queryClient.invalidateQueries({
        queryKey: yuanhengKeys.codexAccountMode,
      });
      queryClient.invalidateQueries({ queryKey: yuanhengKeys.activation });
      queryClient.invalidateQueries({
        queryKey: ["desktop", "tool-connections"],
      });
    },
  });
}
