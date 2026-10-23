import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { imagegenApi, type ImagegenToolStatus } from "@/lib/api/skills";
import type { YuanhengToolId } from "@/lib/api/yuanheng";
import { useYuanhengConnection } from "@/lib/query/yuanheng";

export const imagegenKeys = ["imagegen", "tools"] as const;

type MutationContext = { tool: YuanhengToolId; key: readonly unknown[] };

function statusForTool(status: ImagegenToolStatus, tool: YuanhengToolId) {
  if (status.tool !== tool)
    throw new Error("Image capability response belongs to another tool");
  return status;
}

export function useImagegen(tool: YuanhengToolId) {
  const client = useQueryClient();
  const { data: connection } = useYuanhengConnection();
  const key = [
    ...imagegenKeys,
    tool,
    connection?.baseUrl ?? null,
    connection?.userId ?? null,
    Boolean(connection?.connected),
  ] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: async () => statusForTool(await imagegenApi.getStatus(tool), tool),
    retry: false,
    staleTime: 10_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const groups = useQuery({
    queryKey: [...key, "groups"],
    queryFn: () => imagegenApi.listGroups(tool),
    enabled: Boolean(connection?.connected && query.data?.supported),
    retry: false,
    staleTime: 30_000,
    refetchOnMount: "always",
  });
  const settled = () => {
    void client.invalidateQueries({ queryKey: imagegenKeys });
    void client.invalidateQueries({ queryKey: ["skills", "installed"] });
  };
  const onSuccess = (status: ImagegenToolStatus, context: MutationContext) => {
    client.setQueryData(context.key, statusForTool(status, context.tool));
  };
  const install = useMutation({
    mutationFn: async ({ tool }: MutationContext) =>
      statusForTool(await imagegenApi.install(tool), tool),
    onSuccess,
    onSettled: settled,
  });
  const toggle = useMutation({
    mutationFn: async ({
      tool,
      enabled,
    }: MutationContext & { enabled: boolean }) =>
      statusForTool(await imagegenApi.setEnabled(tool, enabled), tool),
    onSuccess,
    onSettled: settled,
  });
  const configureGroup = useMutation({
    mutationFn: async ({
      tool,
      group,
    }: MutationContext & { group: string | null }) =>
      statusForTool(await imagegenApi.configureGroup(tool, group), tool),
    onSuccess,
    onSettled: settled,
  });
  const exportSkill = useMutation({
    mutationFn: ({ tool, filePath }: MutationContext & { filePath: string }) =>
      imagegenApi.exportSkill(tool, filePath),
    onSettled: settled,
  });
  return {
    query,
    groups,
    contextKey: JSON.stringify(key),
    busy:
      install.isPending ||
      toggle.isPending ||
      configureGroup.isPending ||
      exportSkill.isPending,
    install: () => install.mutateAsync({ tool, key }),
    setEnabled: (enabled: boolean) =>
      toggle.mutateAsync({ tool, key, enabled }),
    configureGroup: (group: string | null) =>
      configureGroup.mutateAsync({ tool, key, group }),
    exportSkill: (filePath: string) =>
      exportSkill.mutateAsync({ tool, key, filePath }),
  };
}
