import { useEffect, useRef } from "react";
import type { YuanhengConnectionStatus } from "@/lib/api";

/** Installation may finish after navigation/logout. Never apply an old account's intent. */
export function useInstallContinuation(connection?: YuanhengConnectionStatus) {
  const identity = JSON.stringify([
    connection?.baseUrl,
    connection?.userId,
    connection?.connected,
  ]);
  const generation = useRef({ identity, epoch: 0 });
  if (generation.current.identity !== identity) {
    generation.current = { identity, epoch: generation.current.epoch + 1 };
  }
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return () => {
    const epoch = generation.current.epoch;
    return () => mounted.current && generation.current.epoch === epoch;
  };
}
