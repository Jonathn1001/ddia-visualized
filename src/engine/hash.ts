import type { LoggedEvent } from './sim';

/** 32-bit FNV-1a. Pass the previous return value as `hash` to chain. */
export function fnv1a(str: string, hash = 0x811c9dc5): number {
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic fingerprint of a run. Payload key order is stable because
 * replays construct payloads through identical code paths.
 */
export function hashEventLog(log: readonly LoggedEvent[]): string {
  let h = 0x811c9dc5;
  for (const e of log) {
    h = fnv1a(
      `${e.index}|${e.time}|${e.target}|${e.kind}|${e.from ?? ''}|${e.delivered ? 1 : 0}|${e.dropReason ?? ''}|${JSON.stringify(e.payload)}`,
      h,
    );
  }
  return h.toString(16).padStart(8, '0');
}
