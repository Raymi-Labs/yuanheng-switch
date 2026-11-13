type CheckHandler = () => Promise<void>;
let handler: CheckHandler | undefined;

export function registerCodexProjectCheck(next: CheckHandler) {
  handler = next;
  return () => {
    if (handler === next) handler = undefined;
  };
}

/** Capture before switching; a late result must not open another account's dialog. */
export function captureCodexProjectCheck(): CheckHandler {
  const captured = handler;
  return async () => {
    if (captured && handler === captured) await captured();
  };
}
