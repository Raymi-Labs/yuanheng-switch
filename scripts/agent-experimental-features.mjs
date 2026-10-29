/** Keep renderer, desktop and separately built Core features aligned. */
// Entry availability is now unconditional. Runtime capability checks remain in
// the backend; compiling the feature does not imply native platform support.
export function agentExperimentalFeatures(_env, _target, _profile) {
  return ["accio-work-experimental"];
}
