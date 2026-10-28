/** Keep renderer, desktop and separately built Core features aligned. */
export function agentExperimentalFeatures(env, target, profile) {
  const requested = env.VITE_ENABLE_ACCIO_WORK === "1";
  if (!requested) return [];
  if (profile === "release" && target !== "aarch64-apple-darwin") {
    throw new Error("Accio 实验安装包仅开放已验收的 Apple Silicon Mac 平台");
  }
  return ["accio-work-experimental"];
}
