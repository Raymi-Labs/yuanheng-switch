type GuideHandler = () => Promise<void>;
let handler: GuideHandler | undefined;

/** The host owns the transient secret; the bridge never caches credentials. */
export function registerCodexLoginGuide(next: GuideHandler) {
  handler = next;
  return () => {
    if (handler === next) handler = undefined;
  };
}

/** Capture before configuring so a late result cannot open another account's guide. */
export function captureCodexLoginGuide(): GuideHandler {
  const captured = handler;
  return async () => {
    if (captured && handler === captured) await captured();
  };
}
