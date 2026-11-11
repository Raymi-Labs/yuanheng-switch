import { invoke } from "@tauri-apps/api/core";
export interface NativePluginRow {
  id: string;
  name: string;
  description: string;
  version: string;
  installed: boolean;
  enabled: boolean;
  pending: boolean;
  changed: boolean;
}
export interface NativePluginStatus {
  targetId: string;
  engine: "desktop" | "cli";
  plugins: NativePluginRow[];
}
export interface NativePluginPlan {
  token: string;
  targetId: string;
  info: {
    name: string;
    version: string;
    description: string;
    license: string;
    digest: string;
    fileCount: number;
    bytes: number;
    skills: number;
    hasMcp: boolean;
    hasHooks: boolean;
    executableFiles: number;
    hasApps: boolean;
    connections: string[];
  };
}
export interface PluginVerification {
  installed: boolean;
  enabled: boolean;
  discoveredSkills: number;
  declaredMcp: number;
  declaredApps: number;
  executionVerified: boolean;
}
export type PluginAction =
  | "enable"
  | "disable"
  | "remove"
  | "verify"
  | "reinstall";
export const nativePluginsApi = {
  status: (tool: string) =>
    invoke<NativePluginStatus>("get_native_plugins", { tool }),
  plan: (
    tool: string,
    targetId: string,
    source: string | null,
    builtinId: string | null,
  ) =>
    invoke<NativePluginPlan>("plan_native_plugin", {
      tool,
      targetId,
      source,
      builtinId,
    }),
  install: (tool: string, targetId: string, token: string) =>
    invoke<void>("install_native_plugin", { tool, targetId, token }),
  action: (tool: string, targetId: string, id: string, action: PluginAction) =>
    invoke<PluginVerification>("native_plugin_action", {
      tool,
      targetId,
      id,
      action,
    }),
};
