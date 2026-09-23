import { useCallback, useInsertionEffect, useRef } from "react";

/*
 * Use this and never React 19.2's own `useEffectEvent`, whose closure swap
 * switches on the fiber tag: inside a `forwardRef` or `memo` component, or any
 * hook called from one, its callback is frozen at the mount closure with no
 * warning.
 */
export function useEventCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
) {
  const latest = useRef(callback);

  // An insertion effect, not a render-time assignment: a render React throws
  // away must not be able to publish its closure to the committed tree.
  useInsertionEffect(() => {
    latest.current = callback;
  });

  return useCallback((...args: Args) => latest.current(...args), []);
}
