import { useMemo } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { sessionSyncApi } from "@/lib/api";
import {
  sessionSyncStateKey,
  type SessionSyncPrefs,
  type SessionSyncScope,
  type SessionSyncState,
} from "@/lib/api/sessionSync";

export const sessionSyncKeys = {
  all: ["session-sync"] as const,
  targets: () => [...sessionSyncKeys.all, "targets"] as const,
  states: () => [...sessionSyncKeys.all, "states"] as const,
  prefs: () => [...sessionSyncKeys.all, "prefs"] as const,
  pending: (target: string, projectDir?: string | null) =>
    [...sessionSyncKeys.all, "pending", target, projectDir ?? "*"] as const,
};

export const invalidateSessionSync = async (queryClient: QueryClient) => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: sessionSyncKeys.all }),
    queryClient.invalidateQueries({ queryKey: ["sessions"] }),
  ]);
};

export const useSessionSyncTargetsQuery = () =>
  useQuery({
    queryKey: sessionSyncKeys.targets(),
    queryFn: () => sessionSyncApi.targets(),
    staleTime: Infinity,
  });

export const useSessionSyncStatesQuery = () => {
  const query = useQuery({
    queryKey: sessionSyncKeys.states(),
    queryFn: () => sessionSyncApi.states(),
    staleTime: 30 * 1000,
  });
  const byKey = useMemo(() => {
    const map = new Map<string, SessionSyncState>();
    for (const state of query.data ?? []) {
      map.set(sessionSyncStateKey(state.providerId, state.sessionId), state);
    }
    return map;
  }, [query.data]);
  return { ...query, byKey };
};

export const useRunSessionSyncMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      targetProvider,
      scope,
    }: {
      targetProvider: string;
      scope?: SessionSyncScope;
    }) => sessionSyncApi.run(targetProvider, scope),
    onSettled: () => invalidateSessionSync(queryClient),
  });
};

export const useUndoSessionSyncMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      targetProvider,
      targetSessionId,
    }: {
      targetProvider: string;
      targetSessionId: string;
    }) => sessionSyncApi.undo(targetProvider, targetSessionId),
    onSettled: () => invalidateSessionSync(queryClient),
  });
};

export const useSessionSyncPrefsQuery = () =>
  useQuery({
    queryKey: sessionSyncKeys.prefs(),
    queryFn: () => sessionSyncApi.getPrefs(),
  });

export const useSaveSessionSyncPrefsMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (prefs: SessionSyncPrefs) => sessionSyncApi.setPrefs(prefs),
    onSuccess: (saved) => {
      queryClient.setQueryData(sessionSyncKeys.prefs(), saved);
    },
  });
};
