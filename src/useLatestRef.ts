import { useEffect, useRef } from "react";

/*
 * The write happens in an effect, so `.current` only catches up once the render
 * commits, unlike `useRenderLatestRef`, which assigns during render.
 */

export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
