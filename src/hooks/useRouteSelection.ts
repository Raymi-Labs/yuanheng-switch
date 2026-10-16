import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  routeSelectionApi,
  type RoutePolicy,
  type RouteStatus,
} from "@/lib/api/routeSelection";

export const routeStatusKey = ["yuanheng-route-status"] as const;
export function useRouteSelection() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: routeStatusKey,
    queryFn: routeSelectionApi.status,
    retry: false,
    refetchInterval: (query) => (query.state.data?.operationId ? 1000 : 15000),
    refetchIntervalInBackground: false,
  });
  const mutation = useMutation({
    onMutate: () => client.cancelQueries({ queryKey: routeStatusKey }),
    mutationFn: (
      action:
        | { policy: RoutePolicy; revision: number }
        | { stream: boolean }
        | { cancel: string },
    ) => {
      if ("policy" in action)
        return routeSelectionApi.setPolicy(action.policy, action.revision);
      if ("cancel" in action) return routeSelectionApi.cancel(action.cancel);
      return routeSelectionApi.probe(action.stream);
    },
    onSuccess: (status) =>
      client.setQueryData<RouteStatus>(routeStatusKey, status),
    // Refetch from Core after either result; GUI never owns policy or probe lifecycle.
    onSettled: () => client.invalidateQueries({ queryKey: routeStatusKey }),
  });
  return { query, mutation };
}
