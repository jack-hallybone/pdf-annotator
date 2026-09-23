import { useRef } from "react";

/*
 * Mirrors `value` into a ref that is up to date during the render that supplied
 * it, unlike `useLatestRef`, whose effect write is a commit behind.
 */
export function useRenderLatestRef<T>(value: T) {
  const ref = useRef(value);
  // Deliberately during render, not in an effect - see above.
  ref.current = value;
  return ref;
}
