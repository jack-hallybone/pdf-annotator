// Attaches a non-enumerable toJSON guard that throws instead of silently
// serializing. Used for SensitivePdfWorkspaceSession, which holds full PDF
// bytes, annotation state and host save targets that must never be
// persisted, logged as JSON, or sent over a network. Without this, the
// "never serialize" rule is enforced only by a comment - JSON.stringify (and
// anything built on it, like localStorage.setItem or a fetch body) would
// silently succeed and leak the payload. The guard is non-enumerable so it
// doesn't show up in Object.keys/for...in or change normal field access.
export function markNonSerializable<T extends object>(value: T): T {
  Object.defineProperty(value, 'toJSON', {
    value() {
      throw new Error(
        'This object must never be serialized (persisted, logged as JSON, or sent over a network).'
      );
    },
    enumerable: false,
    writable: false
  });
  return value;
}
