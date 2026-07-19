/**
 * Single source of truth for every cache/coordination key this module uses.
 *
 * Keys are versioned (`:v1`) so a payload-shape change can be rolled out by
 * bumping the version rather than waiting for TTLs to expire or running a
 * manual flush.
 */

/** Data key holding the serialized active-banner payload. */
export const ACTIVE_BANNERS_CACHE_KEY = 'banners:active:v1';

/** Distributed single-flight lock guarding database loads for `cacheKey`. */
export function bannerLockKey(cacheKey: string): string {
  return `banners:lock:${cacheKey}`;
}

/** Pub/sub channel a lease holder publishes to once fresh data is cached. */
export function bannerReadyChannel(cacheKey: string): string {
  return `banners:ready:${cacheKey}`;
}
