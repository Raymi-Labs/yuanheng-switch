import { invoke } from "@tauri-apps/api/core";

export type RouteId = "primary" | "relay" | "cloudflare";
export interface RoutePolicy {
  mode: "auto" | "fixed";
  fixedRouteId: RouteId;
}
export interface RouteMeasurement {
  routeId: RouteId;
  origin: string;
  successes: number;
  samples: number;
  coldOk: boolean;
  latencyMs: number | null;
  jitterMs: number | null;
  error: string | null;
  streamStatus: string | null;
}
export interface RouteStatus {
  revision: number;
  networkGeneration: number;
  policy: RoutePolicy;
  selectedRouteId: RouteId;
  status:
    | "unknown"
    | "checking"
    | "healthy"
    | "degraded"
    | "unavailable"
    | "stale";
  operationId: string | null;
  lastCheckedAt: string | null;
  reason: string;
  routes: RouteMeasurement[];
  coreRunning: boolean;
}
export const routeSelectionApi = {
  status: () => invoke<RouteStatus>("get_yuanheng_route_status"),
  setPolicy: (policy: RoutePolicy, revision: number) =>
    invoke<RouteStatus>("set_yuanheng_route_policy", { policy, revision }),
  probe: (stream = false) =>
    invoke<RouteStatus>("probe_yuanheng_routes", { stream }),
  cancel: (operationId: string) =>
    invoke<RouteStatus>("cancel_yuanheng_route_probe", { operationId }),
};
