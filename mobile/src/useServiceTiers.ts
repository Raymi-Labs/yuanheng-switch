import { useEffect, useState, useRef } from "react";
import { api } from "./api";
import { TierCapability, validateCapability } from "./serviceTiers";
export function useServiceTiers(
  userId: number,
  model: string,
  group: string,
  active: boolean,
  conversation: string | null,
) {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([
    userId,
    model,
    group,
    conversation,
    attempt,
    active,
  ]);
  const generation = useRef({ key, serial: 0 });
  if (generation.current.key !== key)
    generation.current = { key, serial: generation.current.serial + 1 };
  const serial = generation.current.serial;
  const [result, setResult] = useState<{
    key: string;
    serial: number;
    data?: TierCapability;
    error?: string;
  }>();
  useEffect(() => {
    let live = true;
    if (active && model && group)
      void Promise.resolve()
        .then(() => api.serviceTiers(model, group, userId))
        .then((v) => {
          const data = validateCapability(v, model, group);
          if (live) setResult({ key, serial, data });
        })
        .catch(() => {
          if (live)
            setResult({
              key,
              serial,
              error: "暂时无法确认速度档位，请重试查询",
            });
        });
    return () => {
      live = false;
    };
  }, [key, serial, userId, model, group, active]);
  return {
    data:
      result?.key === key && result.serial === serial ? result.data : undefined,
    error:
      result?.key === key && result.serial === serial
        ? result.error
        : undefined,
    reload: () => setAttempt((n) => n + 1),
  };
}
