/*
 * Exactly one viewport claims an event: one aimed inside a viewport is that
 * viewport's, and one aimed at nothing belongs to the view last touched.
 */

const attachedRoots = new Set<HTMLElement>();
let lastTouchedRoot: HTMLElement | null = null;

export function attachGestureRoot(root: HTMLElement) {
  attachedRoots.add(root);
  if (!lastTouchedRoot) {
    lastTouchedRoot = root;
  }

  return () => {
    attachedRoots.delete(root);
    if (lastTouchedRoot === root) {
      // The next-best answer: whichever viewport is still here.
      lastTouchedRoot = attachedRoots.values().next().value ?? null;
    }
  };
}

export function markGestureRootTouched(root: HTMLElement) {
  if (attachedRoots.has(root)) {
    lastTouchedRoot = root;
  }
}

/**
 * Undecidable cases resolve to the last-touched view rather than to every view:
 * a gesture handled twice is worse than one handled by the wrong view.
 */
export function viewOwnsWindowGesture(
  root: HTMLElement | null,
  target: EventTarget | null,
) {
  if (!root || !attachedRoots.has(root)) {
    return false;
  }

  if (target instanceof Node) {
    if (root.contains(target)) {
      return true;
    }

    for (const other of attachedRoots) {
      if (other !== root && other.contains(target)) {
        return false;
      }
    }
  }

  return (lastTouchedRoot ?? root) === root;
}
