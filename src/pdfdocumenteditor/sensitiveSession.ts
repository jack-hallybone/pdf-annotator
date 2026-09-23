// A toJSON guard that throws instead of silently serializing: a session holds
// full PDF bytes and host save targets, and JSON.stringify - or anything built
// on it, such as localStorage or a fetch body - would otherwise leak them.
export function markNonSerializable<T extends object>(value: T): T {
  Object.defineProperty(value, "toJSON", {
    value() {
      throw new Error(
        "This object must never be serialized (persisted, logged as JSON, or sent over a network).",
      );
    },
    enumerable: false,
    writable: false,
  });
  return value;
}
