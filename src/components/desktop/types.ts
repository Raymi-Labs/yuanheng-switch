export type DesktopView =
  | "home"
  | "tools"
  | "capabilities"
  | "skills"
  | "skillsDiscovery"
  | "mcp"
  | "prompts"
  | "agents"
  | "usage"
  | "voiceClone"
  | "network"
  | "settings"
  | "workspace"
  | "openclawEnv"
  | "openclawTools"
  | "openclawAgents"
  | "hermesMemory";

export function desktopSection(view: DesktopView): DesktopView {
  if (
    ["skills", "skillsDiscovery", "mcp", "prompts", "agents"].includes(view)
  ) {
    return "capabilities";
  }
  return view;
}
