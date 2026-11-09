import { useEffect, useRef, useState } from "react";
import { yuanhengApi } from "@/lib/api/yuanheng";
import { toast } from "@/lib/toast";
import { dt } from "./desktopI18n";

export function useCodexLaunchSpeed(
  enabled: boolean,
  owner?: string | null,
  model?: string,
  group?: string | null,
) {
  const scope = JSON.stringify([enabled, owner, model, group]);
  const identity = JSON.stringify([enabled, owner]);
  const [selection, setSelection] = useState({ tier: "default", identity });
  const [lastLaunch, setLastLaunch] = useState<{
    scope: string;
    tier: string;
  }>();
  const [result, setResult] = useState<{
    scope: string;
    tiers: string[];
    error?: string;
  }>();
  const [reload, setReload] = useState(0);
  const current = useRef(scope);
  // Keep a preference across model/group changes, but never across identities.
  // Until the new scope is verified it cannot produce paid launch parameters.
  const tier = selection.identity === identity ? selection.tier : "default";
  const revision = JSON.stringify([scope, tier]);
  current.current = revision;
  useEffect(() => {
    if (selection.identity === identity) return;
    if (selection.tier !== "default") toast.info(dt("已切回标准"));
    setSelection({ tier: "default", identity });
    setLastLaunch(undefined);
  }, [identity, selection.identity, selection.tier]);
  useEffect(() => {
    if (!enabled) return;
    let queued: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (document.visibilityState === "hidden" || queued) return;
      queued = setTimeout(() => {
        queued = undefined;
        setReload((x) => x + 1);
      }, 150);
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(queued);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled]);
  useEffect(() => {
    let active = true;
    setResult(undefined);
    if (!enabled || !owner || !model || !group) return;
    yuanhengApi
      .getCodexLaunchTiers(model, group, owner)
      .then((rows) => {
        if (active)
          setResult({
            scope,
            tiers: rows
              .map((row) => row.id)
              .filter((id) => id === "priority" || id === "ultrafast"),
          });
      })
      .catch(() => {
        if (active)
          setResult({ scope, tiers: [], error: "无法确认速度支持范围" });
      });
    return () => {
      active = false;
    };
  }, [enabled, owner, model, group, scope, reload]);
  useEffect(() => {
    // Only an affirmative capability response can cause automatic fallback.
    // A timeout is not evidence that the user's paid choice is unsupported.
    if (
      tier === "default" ||
      result?.scope !== scope ||
      result.error ||
      result.tiers.includes(tier)
    )
      return;
    setSelection({ tier: "default", identity });
    toast.info(dt("已切回标准"));
  }, [tier, result, scope, identity]);
  const paid = tier !== "default";
  const valid =
    !paid ||
    (enabled &&
      result?.scope === scope &&
      !result.error &&
      result.tiers.includes(tier));
  return {
    visible:
      enabled && (paid || (result?.scope === scope && result.tiers.length > 0)),
    tier,
    tiers: result?.scope === scope ? result.tiers : [],
    loading:
      enabled && Boolean(owner && model && group) && result?.scope !== scope,
    error:
      paid && !valid && result?.scope === scope
        ? "当前账号、模型或分组尚未确认支持所选档位，请重新选择或重试"
        : result?.scope === scope
          ? result.error
          : undefined,
    valid,
    select: (tier: string) => setSelection({ tier, identity }),
    retry: () => setReload((x) => x + 1),
    request:
      enabled && paid && valid && owner && model && group
        ? { tier, model, group, owner }
        : undefined,
    isCurrent: () => current.current === revision,
    lastLaunchedTier: lastLaunch?.scope === scope ? lastLaunch.tier : undefined,
    markLaunched: () => {
      if (current.current === revision) setLastLaunch({ scope, tier });
    },
  };
}
